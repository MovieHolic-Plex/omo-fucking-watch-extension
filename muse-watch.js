/**
 * Muse stall + premature-stop watchdog for omo (senpi).
 *
 * 1. Silent hang: live model is muse-spark, the parent loop is not idle, and
 *    no stream/tool activity arrives for STALL_MS → abort + continue.
 * 2. Premature stop: muse ends a turn, or sits idle, while pending/in_progress
 *    todos remain, OR a declared "I'll stop when …" contract is still unmet
 *    (no todo-state, like wish-ai-3). The contract is persisted as
 *    muse-watch.contract so later ticks read state, not vibes.
 *
 * Disable: OMO_MUSE_WATCH=0
 * Tune:    OMO_MUSE_STALL_MS (default 40000)
 *          OMO_MUSE_IDLE_TODO_MS (default 8000) — idle grace before todo kick
 *
 * Senpi ExtensionContext has `ctx.model` and no ctx.setTimeout/setInterval.
 * omp has ctx.models.current() plus contained timers. Use whichever exists.
 * Raw timers must catch throws and be cleared on session_shutdown, or a stale
 * ctx after /reload becomes an uncaughtException that kills the session.
 */

const MUSE_RE = /muse-spark/i;
const TODO_STATE_TYPE = "senpi.todo-state";
const CONTRACT_TYPE = "muse-watch.contract";
const OPEN_TODO = new Set(["pending", "in_progress"]);
const STOP_WHEN_RE = /I(?:['’]ll| will) stop when\s+(.+?)(?:\.|$)/i;
const PR_URL_RE = /github\.com\/[^\s)\]>'"]+\/pull\/\d+/i;
const NEEDS_PR_RE = /\bpr\b|pull request|pr url/i;
const USER_WAIT_RE =
  /\b(you confirm|your answer|the user|user replies|you say|wait for (?:the )?user)\b/i;
const STALL_MS = parseDurationEnv("OMO_MUSE_STALL_MS", 40_000);
const IDLE_TODO_MS = parseDurationEnv("OMO_MUSE_IDLE_TODO_MS", 8_000);
const TICK_MS = 5_000;
const COOLDOWN_MS = 60_000;
const MAX_STALL_TRIPS = 4;
const MAX_PREMATURE_TRIPS = 6;
const STALE_CTX_PREFIX = "This extension ctx is stale after session replacement or reload.";
const STALL_PROMPT =
  "Previous model stalled with no stream activity. Continue the same task from where it stopped. Do not restart from scratch.";

function parseDurationEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return fallback;
  return parsed;
}

function enabled() {
  const raw = process.env.OMO_MUSE_WATCH;
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

function modelBlob(ctx) {
  try {
    const model = ctx?.model ?? ctx?.models?.current?.();
    if (model) {
      if (typeof model === "string") return model;
      const blob = [model.id, model.provider, model.name, model.api, model.displayName]
        .filter(Boolean)
        .join(" ");
      if (blob) return blob;
    }
  } catch {
    // fall through to session history
  }
  try {
    const entries =
      ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "model_change") continue;
      return [entry.modelId, entry.provider, entry.model].filter(Boolean).join(" ");
    }
  } catch {
    // ignore
  }
  return "";
}

function isMuse(ctx) {
  const blob = modelBlob(ctx);
  if (blob) return MUSE_RE.test(blob);
  // Unknown model + open todos is the wish-5 /reload case: do not skip.
  return true;
}

function isStaleCtxError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(STALE_CTX_PREFIX);
}

function notify(ctx, message, kind = "warning") {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  } catch {
    // rpc / headless / stale
  }
}

function setWatchStatus(ctx, text) {
  try {
    ctx.ui?.setStatus?.("muse-watch", text);
  } catch {
    // no footer
  }
}

function scheduleTimeout(ctx, fn, ms) {
  const run = () => {
    try {
      fn();
    } catch (error) {
      if (isStaleCtxError(error)) return;
    }
  };
  if (ctx && typeof ctx.setTimeout === "function") {
    return { kind: "ctx", id: ctx.setTimeout(run, ms), ctx };
  }
  return { kind: "raw", id: setTimeout(run, ms) };
}

function scheduleInterval(ctx, fn, ms) {
  const run = () => {
    try {
      fn();
    } catch (error) {
      if (isStaleCtxError(error)) return;
    }
  };
  if (ctx && typeof ctx.setInterval === "function") {
    return { kind: "ctx", id: ctx.setInterval(run, ms), ctx };
  }
  return { kind: "raw", id: setInterval(run, ms) };
}

function clearScheduled(timer) {
  if (!timer) return;
  try {
    if (timer.kind === "ctx") {
      timer.ctx.clearTimer?.(timer.id);
    } else {
      clearTimeout(timer.id);
      clearInterval(timer.id);
    }
  } catch {
    // already gone
  }
}

function readPhases(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.phases)) return null;
  return payload.phases;
}

function branchEntries(ctx) {
  return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
}

function assistantText(entry) {
  const message = entry?.type === "message" ? entry.message : entry;
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function extractStopWhen(text) {
  if (!text) return "";
  const match = STOP_WHEN_RE.exec(text);
  if (!match) return "";
  return match[1].trim().replace(/\s+/g, " ").slice(0, 400);
}

function latestContract(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === CONTRACT_TYPE && entry.data?.when) {
      return entry.data;
    }
  }
  return null;
}

function transcriptHasPull(entries) {
  for (const entry of entries) {
    const raw = JSON.stringify(entry?.message?.content ?? entry?.content ?? entry?.data ?? "");
    if (PR_URL_RE.test(raw)) return true;
  }
  return false;
}

function persistContract(pi, ctx) {
  const entries = branchEntries(ctx);
  let when = "";
  for (const entry of entries) {
    const found = extractStopWhen(assistantText(entry));
    if (found) when = found;
  }
  if (!when) return null;
  const prev = latestContract(entries);
  if (prev?.when === when) return prev;
  try {
    pi.appendEntry(CONTRACT_TYPE, { when, at: Date.now() });
  } catch {
    return { when, at: Date.now() };
  }
  return { when, at: Date.now() };
}

function latestOpenTodos(ctx) {
  const entries = branchEntries(ctx);
  let tasks = [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === TODO_STATE_TYPE) {
      const phases = readPhases(entry.data);
      if (phases) tasks = phases.flatMap((phase) => phase.tasks ?? []);
      continue;
    }
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== "todo" && message.toolName !== "todowrite") continue;
    const phases = readPhases(message.details);
    if (phases) tasks = phases.flatMap((phase) => phase.tasks ?? []);
  }
  return tasks
    .filter((task) => task && OPEN_TODO.has(task.status) && typeof task.content === "string")
    .map((task) => task.content);
}

function unfinishedWork(ctx) {
  const open = latestOpenTodos(ctx);
  if (open.length > 0) return { kind: "todos", open };
  const entries = branchEntries(ctx);
  const contract = latestContract(entries);
  if (!contract?.when) return null;
  if (USER_WAIT_RE.test(contract.when)) return null;
  if (NEEDS_PR_RE.test(contract.when) && !transcriptHasPull(entries)) {
    return { kind: "contract", open: [`I'll stop when ${contract.when}`] };
  }
  return null;
}

function lastAssistantStopReason(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i].stopReason;
  }
  return undefined;
}

function prematurePrompt(work) {
  const open = work.open;
  const listed = open
    .slice(0, 8)
    .map((item) => `- ${item}`)
    .join("\n");
  const extra = open.length > 8 ? `\n- …and ${open.length - 8} more` : "";
  const head =
    work.kind === "contract"
      ? "You ended the turn before your declared stop-when contract held. That is a premature stop."
      : "You ended the turn while todo work is still open. That is a premature stop.";
  return [
    head,
    "Continue the same task now. Do not wait for the user. Do not restart from scratch.",
    work.kind === "contract" ? "Unmet contract:" : "Open todos:",
    listed + extra,
  ].join("\n");
}

export default function (pi) {
  if (!enabled()) return;

  pi.setLabel?.("muse-watch");

  let lastActivity = Date.now();
  let lastStallTrip = 0;
  let lastPrematureTrip = 0;
  let stallTrips = 0;
  let prematureTrips = 0;
  let pending = false;
  let lastTodoSig = "";
  let lastSkip = "";
  let liveCtx;
  let stallTimer;
  let kickTimer;

  const bump = (_event, ctx) => {
    lastActivity = Date.now();
    if (ctx) liveCtx = ctx;
  };

  function stopTimers() {
    clearScheduled(stallTimer);
    clearScheduled(kickTimer);
    stallTimer = undefined;
    kickTimer = undefined;
  }

  function kickPremature(ctx, label) {
    lastSkip = "";
    if (!ctx) {
      lastSkip = "no-ctx";
      return false;
    }
    if (pending) {
      lastSkip = "pending";
      return false;
    }
    if (!isMuse(ctx)) {
      lastSkip = `not-muse:${modelBlob(ctx) || "none"}`;
      return false;
    }
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
      lastSkip = "queued";
      return false;
    }
    if (prematureTrips >= MAX_PREMATURE_TRIPS) {
      lastSkip = "max-trips";
      return false;
    }
    if (Date.now() - lastPrematureTrip < COOLDOWN_MS && prematureTrips > 0) {
      lastSkip = "cooldown";
      return false;
    }

    persistContract(pi, ctx);
    const work = unfinishedWork(ctx);
    if (!work) {
      lastSkip = "no-unfinished";
      return false;
    }

    lastTodoSig = work.open.join("\n");
    lastPrematureTrip = Date.now();
    prematureTrips += 1;
    pending = true;
    const toast = `muse ${label} ${work.kind} x${work.open.length} — continue ${prematureTrips}/${MAX_PREMATURE_TRIPS}`;
    notify(ctx, toast, "warning");
    setWatchStatus(ctx, toast);

    const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    const send = () => {
      try {
        const result = idle
          ? pi.sendUserMessage(prematurePrompt(work))
          : pi.sendUserMessage(prematurePrompt(work), { deliverAs: "followUp" });
        if (result && typeof result.then === "function") {
          result.catch((error) => {
            lastSkip = `send:${error instanceof Error ? error.message : String(error)}`;
            notify(ctx, `muse-watch send failed: ${lastSkip}`, "error");
            setWatchStatus(ctx, `send-fail ${lastSkip}`);
            pending = false;
          });
        }
      } catch (error) {
        lastSkip = `send:${error instanceof Error ? error.message : String(error)}`;
        notify(ctx, `muse-watch send failed: ${lastSkip}`, "error");
        setWatchStatus(ctx, `send-fail ${lastSkip}`);
        pending = false;
        return;
      }
      lastActivity = Date.now();
      pending = false;
    };
    kickTimer = scheduleTimeout(ctx, send, idle ? 0 : 400);
    return true;
  }

  function tick(ctx) {
    if (!ctx || pending) return;
    if (!isMuse(ctx)) return;

    const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : false;
    if (idle) {
      if (Date.now() - lastActivity < IDLE_TODO_MS) return;
      kickPremature(ctx, "idle");
      return;
    }

    if (stallTrips >= MAX_STALL_TRIPS) return;
    const silent = Date.now() - lastActivity;
    if (silent < STALL_MS) return;
    if (Date.now() - lastStallTrip < COOLDOWN_MS) return;

    pending = true;
    lastStallTrip = Date.now();
    stallTrips += 1;
    notify(
      ctx,
      `muse stalled ${Math.round(silent / 1000)}s — abort ${stallTrips}/${MAX_STALL_TRIPS}`,
      "warning",
    );

    try {
      ctx.abort?.();
    } catch (error) {
      pending = false;
      if (isStaleCtxError(error)) stopTimers();
      return;
    }

    kickTimer = scheduleTimeout(
      ctx,
      () => {
        try {
          const result = pi.sendUserMessage(STALL_PROMPT, { deliverAs: "followUp" });
          if (result && typeof result.then === "function") {
            result.catch(() => {
              pending = false;
            });
          }
        } catch {
          pending = false;
          return;
        }
        lastActivity = Date.now();
        pending = false;
      },
      1200,
    );
  }

  function ensureTicker(ctx) {
    if (!ctx || stallTimer) return;
    stallTimer = scheduleInterval(ctx, () => tick(liveCtx || ctx), TICK_MS);
  }

  pi.on("message_update", bump);
  pi.on("message_start", bump);
  pi.on("after_provider_response", (_event, ctx) => {
    bump(_event, ctx);
    stallTrips = 0;
  });
  pi.on("auto_retry_start", bump);
  pi.on("auto_retry_end", bump);
  pi.on("tool_execution_start", bump);
  pi.on("tool_execution_update", bump);
  pi.on("tool_execution_end", bump);
  pi.on("agent_start", bump);
  pi.on("turn_start", bump);
  pi.on("message_end", (event, ctx) => {
    bump(event, ctx);
    if (event?.message?.role !== "assistant") return;
    persistContract(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    stopTimers();
    liveCtx = undefined;
    pending = false;
  });

  pi.on("session_start", (_event, ctx) => {
    liveCtx = ctx;
    lastActivity = Date.now();
    lastStallTrip = 0;
    lastPrematureTrip = 0;
    stallTrips = 0;
    prematureTrips = 0;
    pending = false;
    lastTodoSig = "";
    lastSkip = "";
    stopTimers();
    persistContract(pi, ctx);
    const work = unfinishedWork(ctx);
    const blob = modelBlob(ctx) || "no-model";
    setWatchStatus(
      ctx,
      `armed ${blob} todos=${latestOpenTodos(ctx).length} contract=${work?.kind === "contract" ? "unmet" : "none"}`,
    );
    ensureTicker(ctx);
    const kicked = kickPremature(ctx, "resume");
    if (kicked) return;
    if (!work) return;
    const skipText = `resume skipped (${lastSkip}) ${work.kind}`;
    setWatchStatus(ctx, skipText);
    notify(ctx, `muse-watch ${skipText}`, "warning");
  });

  pi.registerCommand?.("muse-watch", {
    description: "Show muse-watch model/todo status",
    handler: (_args, ctx) => {
      liveCtx = ctx;
      persistContract(pi, ctx);
      const work = unfinishedWork(ctx);
      const text = `model=${modelBlob(ctx) || "none"} muse=${isMuse(ctx)} idle=${ctx.isIdle?.()} unfinished=${work ? work.kind : "none"} skip=${lastSkip || "-"} trips=${prematureTrips}`;
      setWatchStatus(ctx, text);
      notify(ctx, text, "info");
    },
  });

  pi.on("agent_end", (event, ctx) => {
    liveCtx = ctx;
    ensureTicker(ctx);
    if (event?.willRetry === true) return;
    if (event?.aborted === true && event.abortSource === "user") return;
    const reason = lastAssistantStopReason(event);
    if (reason && reason !== "stop" && reason !== "length") return;
    kickPremature(ctx, "stopped");
  });
}
