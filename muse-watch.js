/**
 * Muse stall + premature-stop watchdog for omo (senpi).
 *
 * 1. Silent hang: live model is muse-spark, the parent loop is not idle, and
 *    no stream/tool activity arrives for STALL_MS → abort + continue.
 * 2. Premature stop: muse ends a turn, or sits idle, while pending/in_progress
 *    todos remain → follow-up so the same work keeps going. Idle sessions are
 *    polled; omo -r is not required.
 *
 * Disable: OMO_MUSE_WATCH=0
 * Tune:    OMO_MUSE_STALL_MS (default 40000)
 *          OMO_MUSE_IDLE_TODO_MS (default 8000) — idle grace before todo kick
 *
 * Use ctx.setInterval / ctx.setTimeout only. A raw timer throw tears down
 * the whole session.
 */

const MUSE_RE = /muse-spark/i;
const TODO_STATE_TYPE = "senpi.todo-state";
const OPEN_TODO = new Set(["pending", "in_progress"]);
const STALL_MS = parseDurationEnv("OMO_MUSE_STALL_MS", 40_000);
const IDLE_TODO_MS = parseDurationEnv("OMO_MUSE_IDLE_TODO_MS", 8_000);
const TICK_MS = 5_000;
const COOLDOWN_MS = 60_000;
const MAX_STALL_TRIPS = 4;
const MAX_PREMATURE_TRIPS = 6;
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
    const model = ctx.models?.current?.();
    if (!model) return "";
    return [model.id, model.provider, model.name, model.api].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

function isMuse(ctx) {
  return MUSE_RE.test(modelBlob(ctx));
}

function notify(ctx, message, kind = "warning") {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  } catch {
    // rpc / headless
  }
}

function readPhases(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.phases)) return null;
  return payload.phases;
}

function latestOpenTodos(ctx) {
  const entries =
    ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
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

function lastAssistantStopReason(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i].stopReason;
  }
  return undefined;
}

function prematurePrompt(open) {
  const listed = open
    .slice(0, 8)
    .map((item) => `- ${item}`)
    .join("\n");
  const extra = open.length > 8 ? `\n- …and ${open.length - 8} more` : "";
  return [
    "You ended the turn while todo work is still open. That is a premature stop.",
    "Continue the same task now. Do not wait for the user. Do not restart from scratch.",
    "Open todos:",
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
  let stallTimer;

  const bump = () => {
    lastActivity = Date.now();
  };

  function kickPremature(ctx, label) {
    if (pending) return false;
    if (!isMuse(ctx)) return false;
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return false;
    if (prematureTrips >= MAX_PREMATURE_TRIPS) return false;
    if (Date.now() - lastPrematureTrip < COOLDOWN_MS && prematureTrips > 0) return false;

    const open = latestOpenTodos(ctx);
    if (open.length === 0) return false;

    lastTodoSig = open.join("\n");
    lastPrematureTrip = Date.now();
    prematureTrips += 1;
    pending = true;
    notify(
      ctx,
      `muse ${label} with ${open.length} open todo(s) — continue ${prematureTrips}/${MAX_PREMATURE_TRIPS}`,
      "warning",
    );

    ctx.setTimeout(() => {
      try {
        pi.sendUserMessage(prematurePrompt(open), {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      } catch {
        // follow-up is best effort
      } finally {
        bump();
        pending = false;
      }
    }, 400);
    return true;
  }

  function tick(ctx) {
    if (pending) return;
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
    } catch {
      pending = false;
      return;
    }

    ctx.setTimeout(() => {
      try {
        pi.sendUserMessage(STALL_PROMPT, {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      } catch {
        // follow-up is best effort
      } finally {
        bump();
        pending = false;
      }
    }, 1200);
  }

  function ensureTicker(ctx) {
    if (stallTimer || typeof ctx.setInterval !== "function") return;
    stallTimer = ctx.setInterval(() => tick(ctx), TICK_MS);
  }

  pi.on("message_update", bump);
  pi.on("message_start", bump);
  pi.on("after_provider_response", () => {
    bump();
    stallTrips = 0;
  });
  pi.on("auto_retry_start", bump);
  pi.on("auto_retry_end", bump);
  pi.on("tool_execution_start", bump);
  pi.on("tool_execution_update", bump);
  pi.on("tool_execution_end", bump);
  pi.on("agent_start", bump);
  pi.on("turn_start", bump);

  pi.on("session_start", (_event, ctx) => {
    lastActivity = Date.now();
    lastStallTrip = 0;
    lastPrematureTrip = 0;
    stallTrips = 0;
    prematureTrips = 0;
    pending = false;
    lastTodoSig = "";
    if (stallTimer && typeof ctx.clearTimer === "function") {
      ctx.clearTimer(stallTimer);
      stallTimer = undefined;
    }
    ensureTicker(ctx);
    ctx.setTimeout(() => {
      kickPremature(ctx, "resume");
    }, 800);
  });

  pi.on("agent_end", (event, ctx) => {
    ensureTicker(ctx);
    if (event?.willRetry === true) return;
    if (event?.aborted === true && event.abortSource === "user") return;
    const reason = lastAssistantStopReason(event);
    if (reason && reason !== "stop" && reason !== "length") return;
    kickPremature(ctx, "stopped");
  });
}
