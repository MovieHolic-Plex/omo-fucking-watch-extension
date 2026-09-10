/**
 * Muse watchdog for installed Senpi extension APIs.
 *
 * Stall timers never abort. They only warn: pending completion delivery is
 * still not visible to extensions.
 *
 * When a supported Muse turn ends with stopReason=stop, a separate `omo -p`
 * process classifies whether the last assistant actually completed. The child
 * is ephemeral (--no-session --no-extensions --no-tools) and cannot recurse
 * into this watchdog. Truncated / empty / leftover-tool-call stops are
 * structurally premature and skip the print inspect. A PREMATURE verdict
 * types `continue` into the TUI once idle.
 *
 * Manual /muse-watch continue-confirmed remains available. OMO_MUSE_WATCH=0
 * disables the extension; OMO_MUSE_AUTO_CONTINUE=0 disables only the typed
 * continue; OMO_MUSE_INSPECT=0 falls back to the local classifier;
 * OMO_MUSE_STALL_MS tunes warnings.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const STATE_TYPE = "muse-watch.state";
const TODO_TYPE = "senpi.todo-state";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED_MODELS = new Set([
  "muse/muse-spark-1.3-contributor-free",
  "cliproxy/muse-spark-1.3-contributor-free",
]);
const STATUSES = new Set(["pending", "in_progress", "completed", "abandoned", "cancelled"]);
const OWNERS = Symbol.for("omo.muse-watch.owners.v1");
export const INSPECTOR = Symbol.for("omo.muse-watch.inspector.v1");
const STRUCTURAL_PREMATURE = new Set(["truncated", "empty-stop", "stop-with-tool-calls"]);
const STALE_PREFIX = "This extension ctx is stale after session replacement or reload.";
const TICK_MS = 5_000;
const MAX_STALL_WARNINGS = 4;
const MAX_AUTO_CONTINUES = 6;
const CONTINUE_TEXT = "continue";
const HANDOFF = /I'll stop when|\bgoal complete\b|완료했습니다|완료됐습니다|띄워볼까요|진행할까요|할까요\?|승인 전까지|머지하지 않고 대기|리뷰가 돌아오는 동안 대기|waiting for (you|the user|review)/i;
const DANGLING = [
  /\bi(?:['’]?ll| will) (?!stop when)/i,
  /\b(?:let me|let's|going to|about to)\b/i,
  /^(?:fixing|writing|checking|continuing|implementing)\b/i,
  /\b(?:so checking|checking for)\b/i,
  /완료 알림 오면/,
  /완료되면 결과/,
  /들어갑니다/,
  /작성합니다/,
  /붙입니다/,
  /띄워드리/,
  /고친다/,
  /살펴보/,
  /찾아보/,
  /확인 마저/,
  /실행 중/,
  /조립되는 대로/,
  /검증하고 돌아오/,
  /바로 코드를/,
  /바로 실행/,
];

function stallDuration() {
  const value = Number(process.env.OMO_MUSE_STALL_MS);
  return Number.isSafeInteger(value) && value >= 1_000 ? value : 180_000;
}

function autoContinueEnabled() {
  return !["0", "false", "off", "no"].includes(process.env.OMO_MUSE_AUTO_CONTINUE?.toLowerCase());
}

export function inspectEnabled() {
  return !["0", "false", "off", "no"].includes(process.env.OMO_MUSE_INSPECT?.toLowerCase());
}

export function inspectTimeoutMs() {
  const value = Number(process.env.OMO_MUSE_INSPECT_MS);
  return Number.isSafeInteger(value) && value >= 3_000 ? value : 45_000;
}

export function needsPrintInspect(verdict) {
  if (!inspectEnabled() || !autoContinueEnabled()) return false;
  if (!verdict || verdict.kind === "no-assistant" || verdict.kind === "other") return false;
  if (verdict.kind === "premature" && STRUCTURAL_PREMATURE.has(verdict.why)) return false;
  return true;
}

export function buildInspectPrompt({ stopReason, text, openTodos, model }) {
  const modelLabel = model?.provider && model?.id ? `${model.provider}/${model.id}` : "unknown";
  return [
    "Classify a coding-agent turn that already ended.",
    `stopReason: ${stopReason ?? "unknown"}`,
    `model: ${modelLabel}`,
    `openTodos: ${openTodos ?? "unknown"}`,
    "lastAssistant:",
    "---",
    String(text ?? "").slice(0, 4_000),
    "---",
    "COMPLETE = the assistant finished the work, handed off to the user, asked a question, or explicitly stopped.",
    "PREMATURE = it only announced more work, said it would check/fix/write/run something, waited for a tool notification, or otherwise did not actually finish.",
    "Reply with exactly one line: PREMATURE or COMPLETE.",
  ].join("\n");
}

export function buildInspectCommand(prompt, payload = {}) {
  const bin = process.env.OMO_MUSE_INSPECT_BIN || process.env.OMO_BIN || "omo";
  const args = [
    "-p",
    "--no-extensions",
    "--no-session",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-tools",
    "--omo-senpi-disabled",
    "--thinking", "off",
  ];
  const model = process.env.OMO_MUSE_INSPECT_MODEL
    || (payload.model?.provider && payload.model?.id ? `${payload.model.provider}/${payload.model.id}` : undefined);
  if (model) args.push("--model", model);
  args.push("--", prompt);
  return { bin, args };
}

export function parseInspectVerdict(stdout, stderr = "") {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`;
  const matches = [...text.matchAll(/\b(PREMATURE|COMPLETE)\b/gi)];
  if (matches.length === 0) return "unknown";
  return matches.at(-1)[1].toUpperCase() === "PREMATURE" ? "premature" : "complete";
}

export function spawnOmoInspect(payload) {
  const override = globalThis[INSPECTOR];
  if (typeof override === "function") return Promise.resolve(override(payload));
  const prompt = buildInspectPrompt(payload);
  const { bin, args } = buildInspectCommand(prompt, payload);
  const timeout = inspectTimeoutMs();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        env: {
          ...process.env,
          OMO_MUSE_WATCH: "0",
          OMO_MUSE_AUTO_CONTINUE: "0",
          OMO_MUSE_INSPECT: "0",
          PI_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`omo -p inspect timed out after ${timeout}ms`));
    }, timeout);
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      const verdict = parseInspectVerdict(stdout, stderr);
      if (verdict === "unknown") {
        reject(new Error(`omo -p inspect produced no verdict (exit ${code}): ${stdout.slice(-400)} ${stderr.slice(-400)}`));
        return;
      }
      resolve(verdict);
    });
  });
}

export function lastAssistantFrom(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    const message = entry?.role ? entry : entry?.message;
    if (message?.role !== "assistant") continue;
    return typeof entry?.id === "string" && entry.id && !message.id ? { ...message, id: entry.id } : message;
  }
}

export function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

export function hasToolCalls(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(part => part && ["toolCall", "toolUse", "tool_use"].includes(part.type));
}

export function classifyAssistantStop(assistant, openTodos = null) {
  if (!assistant) return { kind: "no-assistant", why: "missing" };
  const reason = assistant.stopReason;
  if (reason === "length") return { kind: "premature", why: "truncated", openTodos };
  if (reason !== "stop") return { kind: "other", why: reason ?? "missing-stop-reason", openTodos };
  if (hasToolCalls(assistant)) return { kind: "premature", why: "stop-with-tool-calls", openTodos };
  const text = assistantText(assistant).trim();
  if (!text) return { kind: "premature", why: "empty-stop", openTodos };
  if (HANDOFF.test(text)) return { kind: "clean", why: "handoff-or-complete", openTodos };
  if (DANGLING.some(pattern => pattern.test(text))) return { kind: "premature", why: "dangling-next-step", openTodos };
  return { kind: "clean", why: "stop", openTodos };
}

function recoveryKey(assistant) {
  if (typeof assistant?.id === "string" && assistant.id) return `auto:${assistant.id}`;
  const text = assistantText(assistant).trim().slice(0, 80);
  return `auto:${assistant?.stopReason ?? "stop"}:${text}`;
}

function sessionId(ctx) {
  const id = ctx.sessionManager?.getSessionId?.();
  return typeof id === "string" && UUID.test(id) ? id : undefined;
}

function readState(entries, id) {
  let state = { version: 1, sessionId: id, paused: true, attempts: [] };
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    const data = entry.data;
    // Forked/copied records must not grant authority in a different session.
    if (typeof data?.sessionId === "string" && UUID.test(data.sessionId) && data.sessionId !== id) continue;
    if (data?.version !== 1 || data.sessionId !== id || typeof data.paused !== "boolean" ||
        !Array.isArray(data.attempts) || data.attempts.some(key => typeof key !== "string" || key.length === 0) ||
        new Set(data.attempts).size !== data.attempts.length) return null;
    state = { ...data, attempts: [...data.attempts] };
  }
  return state;
}

// Only explicit, structured snapshots on the CURRENT branch. Invalid latest
// state is unknown, not permission to fall back to earlier unfinished work.
function openTodos(entries) {
  if (!Array.isArray(entries)) return null;
  let tasks = [];
  for (const entry of entries) {
    let payload;
    if (entry.type === "custom" && entry.customType === TODO_TYPE) payload = entry.data;
    else if (entry.type === "message" && entry.message?.role === "toolResult" &&
      ["todo", "todowrite"].includes(entry.message.toolName)) {
      payload = entry.message.isError ? undefined : entry.message.details;
    } else continue;
    if (!payload || (payload.schema !== undefined && payload.schema !== "v2")) {
      tasks = null;
      continue;
    }
    if (Array.isArray(payload.phases)) {
      tasks = payload.phases.every(phase => typeof phase?.name === "string" && Array.isArray(phase.tasks))
        ? payload.phases.flatMap(phase => phase.tasks) : null;
    } else tasks = payload.schema === undefined && Array.isArray(payload.todos) ? payload.todos : null;
    if (tasks?.some(task => typeof task?.content !== "string" || !task.content.trim() || !STATUSES.has(task.status))) tasks = null;
  }
  return tasks?.filter(task => task.status === "pending" || task.status === "in_progress") ?? null;
}

export default function museWatch(pi) {
  if (["0", "false", "off", "no"].includes(process.env.OMO_MUSE_WATCH?.toLowerCase())) return;
  const owners = globalThis[OWNERS] ??= new Map();
  const stallMs = stallDuration();
  const wakes = new Map();
  const holds = new Map();
  const inputs = new Map();
  const tools = new Set();
  let pauseGeneration = 0;
  let liveCtx;
  let id;
  let state;
  let valid = false;
  let active = false;
  let disposed = false;
  let timer;
  let retrying = false;
  let lastActivity = Date.now();
  let warned = false;
  let warningCount = 0;
  let autoCount = 0;
  let lastReason = "not-started";
  let lastVerdict = { kind: "none", why: "not-started" };
  let pendingRecovery;
  let inspectGeneration = 0;
  const owner = { stop, command: handleCommand };

  function stop() {
    clearInterval(timer);
    timer = undefined;
    inspectGeneration += 1;
    pendingRecovery = undefined;
    if (id && owners.get(id) === owner) owners.delete(id);
    active = false;
    liveCtx = undefined;
    inputs.clear();
    tools.clear();
  }

  function guarded(ctx, fn) {
    if (!active || disposed) return;
    try {
      if (sessionId(ctx) !== id || (id && owners.get(id) !== owner)) {
        stop();
        return;
      }
      liveCtx = ctx;
      const result = fn();
      if (result && typeof result.then === "function") {
        return result.catch(error => {
          if (!active || disposed) return;
          stop();
          if (!(error instanceof Error && error.message.startsWith(STALE_PREFIX))) {
            console.error("muse-watch context failure; recovery disabled", error);
          }
        });
      }
      return result;
    } catch (error) {
      stop();
      if (!(error instanceof Error && error.message.startsWith(STALE_PREFIX))) {
        console.error("muse-watch context failure; recovery disabled", error);
      }
    }
  }

  function observe() {
    const ctx = liveCtx;
    const model = ctx.model;
    const branch = ctx.sessionManager?.getBranch?.();
    const todos = openTodos(branch);
    const draftEmpty = ctx.mode === "tui" && typeof ctx.ui?.getEditorText === "function" && ctx.ui.getEditorText() === "";
    return {
      version: 1,
      sessionId: id ?? null,
      paused: state?.paused ?? true,
      attempts: state?.attempts.length ?? 0,
      model: model ? { provider: model.provider, id: model.id } : null,
      supportedModel: !!model && SUPPORTED_MODELS.has(`${model.provider}/${model.id}`),
      draftKnownEmpty: draftEmpty,
      idle: ctx.isIdle?.() === true,
      nativeQueueEmpty: ctx.hasPendingMessages?.() === false,
      notCompacting: ctx.isCompacting?.() === false,
      backgroundActive: [...wakes.values()].some(count => count > 0) || [...holds.values()].some(Boolean),
      wakeSources: Object.fromEntries(wakes),
      completionDelivery: "unknown",
      automaticContinuation: autoContinueEnabled() ? "premature-stop-continue" : "disabled",
      automaticAbort: false,
      stopVerdict: lastVerdict,
      pendingPrematureStop: pendingRecovery?.inspecting ? null : pendingRecovery?.verdict.why ?? null,
      inspectingStop: pendingRecovery?.inspecting === true,
      autoContinues: autoCount,
      openTodos: todos === null ? null : todos.length,
      stalled: false,
    };
  }

  function publish(reason = lastReason, snapshot = observe()) {
    lastReason = reason;
    const data = { ...snapshot, reason };
    pi.events.emit("muse_watch_state", data);
    // Real Senpi RPC extension events; useful to read-only diagnostics clients.
    pi.rpc?.emit("muse_watch_state", data);
    liveCtx.ui?.setStatus?.("muse-watch", `${reason}; open=${data.openTodos ?? "unknown"}; auto=${data.automaticContinuation}`);
    return data;
  }

  function notify(message, kind = "info") {
    if (liveCtx.hasUI) liveCtx.ui.notify(message, kind);
  }

  function persist(next) {
    // Keep the local restriction even if append fails after a partial write.
    state = next;
    try {
      pi.appendEntry(STATE_TYPE, state);
      return true;
    } catch (error) {
      valid = false;
      console.error("muse-watch persistence failed; recovery disabled", error);
      publish("persistence-failed");
      notify("muse-watch could not persist state. No continuation will be sent.", "error");
      return false;
    }
  }

  function setPaused(paused) {
    // Older inputs cannot undo a newer pause, but remain admission holds
    // until their dispositions arrive. Resume must not erase those holds.
    if (paused) pauseGeneration += 1;
    if (!id) return publish("invalid-session");
    if (!valid) return publish("invalid-state");
    if (persist({ ...state, paused })) publish(paused ? "paused" : "observing-only");
  }

  function activity() {
    lastActivity = Date.now();
    warned = false;
  }

  function veto(snapshot) {
    if (!id) return "invalid-session";
    if (!valid) return "invalid-state";
    if (state.paused) return "paused";
    if (!snapshot.supportedModel) return "unsupported-model";
    if (!snapshot.draftKnownEmpty) return "draft-not-known-empty";
    if (!snapshot.nativeQueueEmpty) return "queued-messages";
    if (!snapshot.notCompacting) return "compacting-or-unknown";
    if (inputs.size) return "input-pending";
    if (snapshot.backgroundActive) return "background-active";
    if (retrying || tools.size) return "agent-busy";
  }

  function tick() {
    tryAutoContinue();
    const snapshot = observe();
    if (veto(snapshot) || snapshot.idle || Date.now() - lastActivity < stallMs) return;
    publish("stall-observed", { ...snapshot, stalled: true });
    if (!warned && warningCount < MAX_STALL_WARNINGS) {
      warned = true;
      warningCount += 1;
      notify("Muse has no recent stream/tool activity. No automatic abort or resend: pending completion delivery is unknown. Inspect the run; use Escape to stop it yourself.", "warning");
    }
  }

  function tryAutoContinue() {
    if (!pendingRecovery || pendingRecovery.inspecting || !autoContinueEnabled()) return;
    const snapshot = observe();
    const blocked = veto(snapshot) ?? (snapshot.idle ? undefined : "agent-busy");
    if (blocked) {
      if (["paused", "draft-not-known-empty", "queued-messages", "input-pending", "invalid-session", "invalid-state"].includes(blocked)) {
        pendingRecovery = undefined;
        publish(blocked, snapshot);
      }
      return;
    }
    if (autoCount >= MAX_AUTO_CONTINUES) {
      pendingRecovery = undefined;
      publish("auto-continue-capped", snapshot);
      notify("muse-watch: premature-stop continue cap reached. Type continue yourself if the run is still unfinished.", "warning");
      return;
    }
    const key = pendingRecovery.key;
    if (state.attempts.includes(key)) {
      pendingRecovery = undefined;
      publish("attempt-already-claimed", snapshot);
      return;
    }
    const file = liveCtx.sessionManager.getSessionFile?.();
    const entries = liveCtx.sessionManager.getEntries();
    if (typeof file !== "string" || !isAbsolute(file) || !entries.some(entry => entry.type === "message" && entry.message?.role === "assistant")) {
      pendingRecovery = undefined;
      publish("non-durable-session", snapshot);
      return;
    }
    if (!persist({ ...state, attempts: [...state.attempts, key] })) return;
    const why = pendingRecovery.verdict.why;
    try {
      pi.sendUserMessage(CONTINUE_TEXT, { deliverAs: "followUp" });
      autoCount += 1;
      pendingRecovery = undefined;
      publish("auto-continue-sent", snapshot);
      notify(`muse-watch: premature stop (${why}). Typed continue.`);
    } catch (error) {
      console.error("muse-watch auto-continue outcome unknown; claim retained", error);
      pendingRecovery = undefined;
      publish("send-outcome-unknown");
      notify("Continuation delivery is unknown. The attempt remains claimed and will not be retried.", "error");
    }
  }

  // Bus subscriptions are installed before session_start. A zero only removes
  // that source's positive veto: it NEVER proves pending delivery is empty.
  const unsubscribers = [
    pi.events.on("wake_source_state", data => {
      if (disposed || typeof data?.source !== "string" || !data.source ||
          !Number.isSafeInteger(data.activeCount) || data.activeCount < 0) return;
      wakes.set(data.source, data.activeCount);
    }),
    pi.events.on("continuation_hold_state", data => {
      if (!disposed && typeof data?.source === "string" && typeof data.active === "boolean") holds.set(data.source, data.active);
    }),
    pi.events.on("goal_continuation_timer_state", data => {
      if (!disposed && typeof data?.armed === "boolean") holds.set("goal-timer", data.armed);
    }),
  ];

  pi.on("session_start", (_event, ctx) => {
    if (disposed) return;
    stop();
    try {
      id = sessionId(ctx);
      if (id) owners.get(id)?.stop();
      if (id) owners.set(id, owner);
      liveCtx = ctx;
      active = true;
      state = id ? readState(ctx.sessionManager.getEntries(), id) : null;
      valid = state !== null;
      retrying = false;
      activity();
      warningCount = 0;
      autoCount = 0;
      inspectGeneration += 1;
      pendingRecovery = undefined;
      lastVerdict = { kind: "none", why: "session-start" };
      publish(!id ? "invalid-session" : !valid ? "invalid-state" : state.paused ? "paused" : "observing-only");
      if (id && valid) timer = setInterval(() => guarded(liveCtx, tick), TICK_MS);
    } catch (error) {
      stop();
      console.error("muse-watch initialization failed; recovery disabled", error);
    }
  });

  // Before-switch/fork events are cancellable and may precede validation.
  // Retire only on shutdown, a new session_start, or an observed identity change.
  pi.on("session_shutdown", () => {
    disposed = true;
    stop();
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  for (const event of ["message_start", "message_update", "message_end", "after_provider_response", "tool_execution_update", "turn_start", "model_select"]) {
    pi.on(event, (_event, ctx) => guarded(ctx, activity));
  }
  pi.on("tool_execution_start", (event, ctx) => guarded(ctx, () => { tools.add(event.toolCallId); activity(); }));
  pi.on("tool_execution_end", (event, ctx) => guarded(ctx, () => { tools.delete(event.toolCallId); activity(); }));
  pi.on("agent_start", (_event, ctx) => guarded(ctx, () => {
    // Disposition handlers finish before _promptAgent marks the run active.
    // Only this transition closes the accepted-input admission gap.
    if (ctx.isIdle?.() === false) {
      for (const [inputId, input] of inputs) {
        if (["started", "queued"].includes(input.disposition)) inputs.delete(inputId);
      }
    }
    retrying = false;
    inspectGeneration += 1;
    pendingRecovery = undefined;
    activity();
  }));
  pi.on("agent_settled", (_event, ctx) => guarded(ctx, () => {
    retrying = false;
    activity();
    tryAutoContinue();
    publish();
  }));
  pi.on("agent_end", (event, ctx) => guarded(ctx, async () => {
    retrying = event.willRetry === true;
    inspectGeneration += 1;
    const generation = inspectGeneration;
    if (event.aborted === true && event.abortSource === "user") {
      pendingRecovery = undefined;
      lastVerdict = { kind: "other", why: "user-abort" };
      setPaused(true);
      return;
    }
    if (retrying) {
      pendingRecovery = undefined;
      lastVerdict = { kind: "other", why: "retrying" };
      return;
    }
    const assistant = lastAssistantFrom(event.messages) ?? lastAssistantFrom(ctx.sessionManager?.getBranch?.());
    const todos = openTodos(ctx.sessionManager?.getBranch?.());
    const regexVerdict = classifyAssistantStop(assistant, todos === null ? null : todos.length);
    lastVerdict = regexVerdict;
    if (!assistant || regexVerdict.kind === "other" || regexVerdict.kind === "no-assistant") {
      pendingRecovery = undefined;
      return;
    }
    const key = recoveryKey(assistant);
    if (regexVerdict.kind === "premature" && STRUCTURAL_PREMATURE.has(regexVerdict.why)) {
      pendingRecovery = { key, verdict: regexVerdict };
      publish("premature-stop");
      return;
    }
    if (!needsPrintInspect(regexVerdict)) {
      if (regexVerdict.kind === "premature") {
        pendingRecovery = { key, verdict: regexVerdict };
        publish("premature-stop");
      } else {
        pendingRecovery = undefined;
      }
      return;
    }
    pendingRecovery = { key, verdict: { kind: "pending-inspect", why: "omo-p" }, inspecting: true };
    publish("inspecting-stop");
    notify("muse-watch: stop ended; asking omo -p whether the turn actually completed.");
    try {
      const printed = await spawnOmoInspect({
        stopReason: assistant.stopReason,
        text: assistantText(assistant),
        openTodos: regexVerdict.openTodos,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
        regexKind: regexVerdict.kind,
        regexWhy: regexVerdict.why,
      });
      if (disposed || !active || generation !== inspectGeneration) return;
      if (printed === "premature") {
        lastVerdict = { kind: "premature", why: "omo-p", openTodos: regexVerdict.openTodos };
        pendingRecovery = { key, verdict: lastVerdict };
        publish("premature-stop");
        tryAutoContinue();
        return;
      }
      lastVerdict = { kind: "clean", why: "omo-p-complete", openTodos: regexVerdict.openTodos };
      pendingRecovery = undefined;
      publish("inspect-complete");
    } catch (error) {
      if (disposed || !active || generation !== inspectGeneration) return;
      console.error("muse-watch omo -p inspect failed; falling back to local classifier", error);
      if (regexVerdict.kind === "premature") {
        lastVerdict = { ...regexVerdict, why: `${regexVerdict.why}+inspect-failed` };
        pendingRecovery = { key, verdict: lastVerdict };
        publish("inspect-failed-fallback");
        tryAutoContinue();
        return;
      }
      pendingRecovery = undefined;
      lastVerdict = { ...regexVerdict, why: `${regexVerdict.why}+inspect-failed` };
      publish("inspect-failed-clean");
    }
  }));
  pi.on("session_abort", (_event, ctx) => guarded(ctx, () => {
    inspectGeneration += 1;
    pendingRecovery = undefined;
    setPaused(true);
  }));
  pi.on("input", (event, ctx) => guarded(ctx, () => {
    if (["interactive", "rpc"].includes(event.source) && typeof event.inputId === "string") {
      inputs.set(event.inputId, { generation: pauseGeneration, disposition: "pending" });
    }
  }));
  pi.on("input_disposition", (event, ctx) => guarded(ctx, () => {
    const input = inputs.get(event.inputId);
    if (!input) return;
    if (["handled", "rejected", "cancelled"].includes(event.disposition)) {
      inputs.delete(event.inputId);
      return;
    }
    if (!["started", "queued"].includes(event.disposition)) return;
    input.disposition = event.disposition;
    if (event.disposition === "queued" && ctx.hasPendingMessages?.() === true) inputs.delete(event.inputId);
    if (input.generation === pauseGeneration) {
      // Pause acceptance and admission ownership are separate: a started input
      // clears pause but retains its hold until agent_start or rejection.
      if (id && valid && persist({ ...state, paused: false })) publish("observing-only");
    }
  }));

  function handleCommand(args, ctx) {
    return guarded(ctx, () => {
      const command = args.trim() || "status";
      if (command === "pause" || command === "resume") {
        setPaused(command === "pause");
        notify("muse-watch: pause state updated only if persisted; automatic abort/continuation remains disabled.");
        return;
      }
      if (command === "status") { notify(JSON.stringify(publish())); return; }
      if (!["continue", "continue-confirmed"].includes(command)) {
        publish("unknown-command");
        notify("Use /muse-watch status, pause, resume, continue, or continue-confirmed.");
        return;
      }
      const snapshot = observe();
      const blocked = veto(snapshot) ?? (!snapshot.idle ? "agent-busy" :
        snapshot.openTodos === null ? "invalid-todos" : snapshot.openTodos === 0 ? "no-open-todos" : undefined);
      if (blocked) {
        publish(blocked, snapshot);
        notify(`Manual continuation blocked: ${blocked}. Resume only clears pause; it does not prove background delivery is empty.`, "warning");
        return;
      }
      if (command === "continue") {
        publish("confirmation-required", snapshot);
        notify("Pending completion delivery is UNKNOWN, even with zero live wake sources. /muse-watch continue-confirmed explicitly requests one manual continuation despite that uncertainty. Known queued messages, live background work, pause and drafts still block it. No automatic continuation is enabled.", "warning");
        return;
      }
      const file = ctx.sessionManager.getSessionFile?.();
      const entries = ctx.sessionManager.getEntries();
      // Senpi defers the initial JSONL flush until an assistant entry exists.
      if (typeof file !== "string" || !isAbsolute(file) || !entries.some(entry => entry.type === "message" && entry.message?.role === "assistant")) {
        publish("non-durable-session", snapshot);
        notify("No manual continuation: this session cannot durably record an attempt yet.", "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const admissionKey = branch.findLast(entry => entry.type === "message" && entry.message?.role === "user")?.id;
      if (typeof admissionKey !== "string" || !admissionKey) { publish("no-user-turn", snapshot); return; }
      if (state.attempts.includes(admissionKey)) {
        publish("attempt-already-claimed", snapshot);
        notify("A continuation was already attempted for this user turn. Its delivery may be unknown; it will not be retried. Send a new instruction yourself if needed.", "warning");
        return;
      }
      if (!persist({ ...state, attempts: [...state.attempts, admissionKey] })) return;
      // No await between validation, claim, and invocation. Custom messages do
      // not create a new user admission. A void return is NOT a delivery receipt.
      try {
        pi.sendMessage({
          customType: "muse-watch.continue",
          content: "The user explicitly requested a manual continuation. Reassess the current task and its explicit open todos, account for any background results, and continue without restarting completed work. Respect blockers and requests for user input.",
          display: true,
          details: { sessionId: id, admissionKey },
        }, { triggerTurn: true, deliverAs: "followUp" });
        publish("manual-attempt-claimed");
        notify("One manual continuation was claimed and submitted; delivery is not acknowledged. Automatic recovery remains disabled.");
      } catch (error) {
        console.error("muse-watch send outcome unknown; claim retained", error);
        publish("send-outcome-unknown");
        notify("Continuation delivery is unknown. The attempt remains claimed and will not be retried.", "error");
      }
    });
  }

  pi.registerCommand("muse-watch", {
    description: "Status/pause/resume; auto-types continue after a premature Muse stop; continue-confirmed is the manual override.",
    handler: (args, ctx) => {
      if (disposed) return;
      try {
        // Senpi retains duplicate commands as :1/:2. Every alias must invoke
        // the live owner's state and pi, never revive its own stopped instance.
        const currentId = sessionId(ctx);
        const currentOwner = currentId ? owners.get(currentId) : owner;
        currentOwner?.command(args, ctx);
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith(STALE_PREFIX))) {
          console.error("muse-watch command routing failed; no action taken", error);
        }
      }
    },
  });
}
