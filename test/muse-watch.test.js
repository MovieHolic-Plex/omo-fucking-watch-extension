import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAssistantStop,
  INSPECTOR,
  parseInspectVerdict,
  buildInspectCommand,
  buildInspectPrompt,
  needsPrintInspect,
} from "../muse-watch.js";

const SID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const STATE = "muse-watch.state";
const MODEL = { provider: "muse", id: "muse-spark-1.3-contributor-free" };
let moduleId = 0;

// Time itself is under test. Every callback runs chronologically, without sleeps.
function virtualClock(t) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (fn, ms) => {
    const id = ++nextId;
    timers.set(id, { fn, ms, due: now + ms });
    return id;
  });
  t.mock.method(globalThis, "clearInterval", id => timers.delete(id));
  return {
    timers,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        const [, timer] = next;
        now = timer.due;
        timer.due += timer.ms;
        await timer.fn();
      }
      now = target;
    },
  };
}

async function harness(t, options = {}) {
  const clock = virtualClock(t);
  for (const [key, value] of Object.entries({ OMO_MUSE_WATCH: "1", OMO_MUSE_STALL_MS: "40000" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => previous === undefined ? delete process.env[key] : (process.env[key] = previous));
  }
  const previousInspector = globalThis[INSPECTOR];
  const inspections = [];
  globalThis[INSPECTOR] = payload => {
    inspections.push(payload);
    return options.inspect ? options.inspect(payload, inspections) : (payload.regexKind === "premature" ? "premature" : "complete");
  };
  t.after(() => {
    if (previousInspector === undefined) delete globalThis[INSPECTOR];
    else globalThis[INSPECTOR] = previousInspector;
  });
  const { default: extension } = await import(`../muse-watch.js?test=${++moduleId}`);
  const handlers = new Map();
  const commands = new Map();
  const listeners = new Map();
  const snapshots = [];
  const sent = [];
  const aborts = [];
  const notifications = [];
  const entries = [
    { type: "message", id: "user-1", message: { role: "user", content: "Do the task" } },
    { type: "message", id: "assistant-1", message: { role: "assistant", content: [] } },
  ];
  let sequence = 0;
  const state = {
    sid: SID, file: `/sessions/${SID}.jsonl`, idle: true, queued: false,
    compacting: false, draft: "", model: MODEL, mode: "tui", stale: false,
    branch: entries, entries, appendError: false,
  };
  const active = fn => (...args) => {
    if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
    return fn(...args);
  };
  const ctx = {
    get model() { return active(() => state.model)(); },
    get mode() { return active(() => state.mode)(); },
    hasUI: true,
    isIdle: active(() => state.idle),
    hasPendingMessages: active(() => state.queued),
    isCompacting: active(() => state.compacting),
    ui: {
      getEditorText: active(() => state.draft),
      notify: active((...args) => notifications.push(args)),
      setStatus: active(() => {}),
      setEditorText() { assert.fail("must never overwrite the editor"); },
    },
    sessionManager: {
      getSessionId: active(() => state.sid),
      getSessionFile: active(() => state.file),
      getEntries: active(() => state.entries),
      getBranch: active(() => state.branch),
    },
    abort: source => aborts.push(source),
  };
  const bus = (name, data) => {
    if (name === "muse_watch_state") snapshots.push(data);
    for (const fn of listeners.get(name) ?? []) fn(data);
  };
  const pi = {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    events: {
      on(name, fn) {
        const set = listeners.get(name) ?? new Set();
        listeners.set(name, set);
        set.add(fn);
        return () => set.delete(fn);
      },
      emit: bus,
    },
    // Each extension retains its registered callback. Senpi resolves duplicate
    // names as muse-watch:1/:2; it does not overwrite the earlier handler.
    registerCommand(name, spec) { commands.set(name, [...(commands.get(name) ?? []), spec.handler]); },
    appendEntry(customType, data) {
      if (state.appendError) throw new Error("disk full");
      const entry = { type: "custom", id: `entry-${++sequence}`, customType, data: structuredClone(data) };
      state.entries.push(entry);
      if (state.branch !== state.entries) state.branch.push(entry);
    },
    sendMessage(message, sendOptions) {
      const persisted = state.entries.filter(e => e.customType === STATE).at(-1)?.data;
      options.onSend?.(persisted);
      sent.push({ message, options: sendOptions });
      options.send?.();
      // Actual installed API is fire-and-forget, not a promise receipt.
    },
    sendUserMessage(content, sendOptions) {
      sent.push({ content, options: sendOptions });
    },
  };
  async function emit(type, event = {}) {
    for (const fn of handlers.get(type) ?? []) await fn({ type, ...event }, ctx);
  }
  const command = async (args, occurrence) => {
    const registered = commands.get("muse-watch") ?? [];
    const handler = registered[(occurrence ?? registered.length) - 1];
    assert.ok(handler);
    await handler(args, ctx);
  };
  const todos = (status = "pending") => pi.appendEntry("senpi.todo-state", {
    schema: "v2", phases: [{ name: "Work", tasks: [{ content: "task-1", status }] }],
  });
  extension(pi);
  t.after(() => { state.stale = false; return emit("session_shutdown", { reason: "quit" }); });
  return {
    clock, state, ctx, pi, sent, aborts, notifications, entries, emit, command, todos, bus, inspections,
    snapshot: () => snapshots.at(-1),
    install: () => extension(pi),
    async start() { await emit("session_start", { reason: "resume" }); },
    async reload() {
      await emit("session_shutdown", { reason: "reload" });
      handlers.clear(); commands.clear();
      extension(pi);
      await emit("session_start", { reason: "reload" });
    },
    async ready() { todos(); await emit("session_start"); await command("resume"); },
  };
}

function noAutomaticActions(h) {
  assert.equal(h.sent.length, 0);
  assert.equal(h.aborts.length, 0);
}

function reason(h, expected) {
  assert.equal(h.snapshot()?.reason, expected);
}

test("registration uses no runtime actions before session_start", async t => {
  const h = await harness(t);
  assert.equal(h.entries.length, 2);
  assert.equal(h.clock.timers.size, 0);
});

test("idle, resume, empty agent_end, and settled never auto-send despite open todos", async t => {
  const h = await harness(t);
  await h.ready();
  await h.emit("agent_end", { messages: [] });
  await h.emit("agent_settled");
  await h.clock.advance(600_000);
  noAutomaticActions(h);
  assert.equal(h.snapshot().automaticContinuation, "premature-stop-continue");
  assert.equal(h.snapshot().openTodos, 1);
});

test("silent live Muse produces one warning at the boundary, never abort-and-send", async t => {
  const h = await harness(t);
  await h.ready();
  h.state.idle = false;
  await h.emit("agent_start");
  const before = h.notifications.length;
  await h.clock.advance(39_999);
  assert.equal(h.notifications.length, before);
  await h.clock.advance(1);
  assert.equal(h.notifications.length, before + 1);
  assert.equal(h.snapshot().stalled, true);
  await h.clock.advance(600_000);
  assert.equal(h.notifications.length, before + 1);
  noAutomaticActions(h);
});

test("overlapping tools veto stall warnings until both finish", async t => {
  const h = await harness(t);
  await h.ready(); h.state.idle = false;
  await h.emit("tool_execution_start", { toolCallId: "a" });
  await h.emit("tool_execution_start", { toolCallId: "b" });
  const before = h.notifications.length;
  await h.clock.advance(90_000);
  await h.emit("tool_execution_end", { toolCallId: "a" });
  await h.clock.advance(90_000);
  assert.equal(h.notifications.length, before);
  await h.emit("tool_execution_end", { toolCallId: "b" });
  await h.clock.advance(40_000);
  assert.equal(h.notifications.length, before + 1);
  noAutomaticActions(h);
});

test("retry, compaction, queue and stream activity protect stall detection", async t => {
  const h = await harness(t);
  await h.ready(); h.state.idle = false;
  const before = h.notifications.length;
  await h.emit("agent_end", { willRetry: true });
  await h.clock.advance(90_000);
  await h.emit("agent_start");
  h.state.compacting = true;
  await h.clock.advance(90_000);
  h.state.compacting = false; h.state.queued = true;
  await h.clock.advance(90_000);
  h.state.queued = false;
  for (const event of ["message_start", "message_update", "after_provider_response", "tool_execution_update", "turn_start", "message_end"]) {
    await h.emit(event);
    await h.clock.advance(35_000);
  }
  assert.equal(h.notifications.length, before);
  await h.clock.advance(5_000);
  assert.equal(h.notifications.length, before + 1);
});

for (const model of [undefined, { id: MODEL.id }, { ...MODEL, provider: "other" },
  { ...MODEL, id: "fake-muse-spark" }, { provider: "other", id: "gpt", name: MODEL.id }]) {
  test(`exact live model only: ${JSON.stringify(model)}`, async t => {
    const h = await harness(t);
    h.entries.push({ type: "model_change", modelId: MODEL.id, provider: MODEL.provider });
    Object.assign(h.ctx, { models: { current: () => MODEL } });
    await h.ready(); h.state.model = model; h.state.idle = false;
    const before = h.notifications.length;
    await h.clock.advance(90_000);
    assert.equal(h.notifications.length, before);
    h.state.idle = true;
    await h.command("continue-confirmed");
    reason(h, "unsupported-model"); noAutomaticActions(h);
  });
}

test("both installed exact provider/id pairs are supported, live switches are re-read", async t => {
  const h = await harness(t);
  await h.ready();
  h.state.model = { ...MODEL, provider: "cliproxy" };
  await h.command("continue-confirmed");
  assert.equal(h.sent.length, 1);
  h.state.model = { ...MODEL, provider: "wrong" };
  await h.command("continue-confirmed"); reason(h, "unsupported-model");
});

for (const [mode, draft] of [["tui", " "], ["tui", "draft"], ["tui", "[Image #1]"],
  ["rpc", ""], ["app-server", ""], ["json", ""], ["print", ""], [undefined, ""]]) {
  test(`draft fails closed for ${mode}/${JSON.stringify(draft)}`, async t => {
    const h = await harness(t);
    await h.ready(); h.state.mode = mode; h.state.draft = draft; h.state.idle = false;
    const before = h.notifications.length;
    await h.clock.advance(90_000);
    assert.equal(h.notifications.length, before);
    h.state.idle = true;
    await h.command("continue-confirmed");
    reason(h, "draft-not-known-empty"); noAutomaticActions(h);
  });
}

test("missing editor API and context read errors do not authorize sends", async t => {
  const h = await harness(t);
  await h.ready(); delete h.ctx.ui.getEditorText;
  await h.command("continue-confirmed"); reason(h, "draft-not-known-empty");
  h.ctx.ui.getEditorText = () => { throw new Error("editor failed"); };
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  await h.command("continue-confirmed");
  assert.equal(errors.length, 1); noAutomaticActions(h);
});

for (const event of ["session_abort", "agent_end"]) {
  test(`${event} user pause survives agent_start, generated input and reload`, async t => {
    const h = await harness(t);
    await h.ready();
    await h.emit(event, { aborted: true, abortSource: "user" });
    await h.emit("agent_start");
    await h.emit("input", { inputId: "extension-1", source: "extension" });
    await h.emit("input_disposition", { inputId: "extension-1", disposition: "started" });
    await h.reload();
    await h.command("continue-confirmed"); reason(h, "paused");
    assert.equal(h.entries.filter(e => e.customType === STATE).at(-1).data.paused, true);
    noAutomaticActions(h);
  });
}

test("late user abort wins over a system abort and settlement", async t => {
  const h = await harness(t); await h.ready();
  await h.emit("agent_end", { aborted: true, abortSource: "system" });
  await h.emit("agent_settled");
  await h.emit("session_abort");
  await h.command("continue-confirmed"); reason(h, "paused"); noAutomaticActions(h);
});

test("only correlated direct accepted input clears pause; acceptance before abort cannot clear it later", async t => {
  const h = await harness(t); await h.ready(); await h.command("pause");
  for (const disposition of ["handled", "rejected"]) {
    await h.emit("input", { source: "interactive", inputId: disposition });
    await h.emit("input_disposition", { inputId: disposition, disposition });
    assert.equal(h.snapshot().paused, true);
  }
  await h.emit("input_disposition", { inputId: "unseen", disposition: "started" });
  assert.equal(h.snapshot().paused, true);
  await h.emit("input", { source: "interactive", inputId: "old" });
  await h.emit("session_abort");
  await h.emit("input_disposition", { inputId: "old", disposition: "started" });
  assert.equal(h.snapshot().paused, true);
  for (const disposition of ["queued", "started"]) {
    await h.emit("input", { source: "rpc", inputId: disposition });
    await h.emit("input_disposition", { inputId: disposition, disposition });
    assert.equal(h.snapshot().paused, false);
    await h.command("pause");
  }
  noAutomaticActions(h);
});

test("pause state is session-wide, not lost by navigating to an older branch", async t => {
  const h = await harness(t); await h.ready();
  const older = [...h.entries];
  await h.command("pause"); h.state.branch = older;
  await h.reload();
  await h.command("continue-confirmed"); reason(h, "paused");
});

test("replacement invalidates callbacks and foreign session records never unpause a new identity", async t => {
  const h = await harness(t); await h.ready();
  await h.emit("session_before_switch");
  assert.equal(h.clock.timers.size, 1);
  h.state.sid = OTHER;
  await h.emit("message_update");
  assert.equal(h.clock.timers.size, 0);
  await h.start();
  await h.command("continue-confirmed"); reason(h, "paused");
  noAutomaticActions(h);
});

for (const sid of [undefined, "", "unknown-session", 7]) {
  test(`invalid identity ${sid} denies persistence and continuation`, async t => {
    const h = await harness(t); h.state.sid = sid;
    h.todos(); await h.start(); await h.command("resume");
    await h.command("continue-confirmed"); reason(h, "invalid-session");
    assert.equal(h.entries.filter(e => e.customType === STATE).length, 0);
    noAutomaticActions(h);
  });
}

test("malformed latest owned state denies resume instead of erasing an ambiguous claim", async t => {
  const h = await harness(t); await h.ready();
  h.pi.appendEntry(STATE, { version: 1, sessionId: SID, paused: false, attempts: "broken" });
  await h.reload(); await h.command("resume");
  await h.command("continue-confirmed"); reason(h, "invalid-state"); noAutomaticActions(h);
});

for (const source of ["senpi-task", "senpi-codemode", "terminal-monitors", "terminal-background-sessions", "omo-dag", "future-source"]) {
  test(`${source} is a veto, including snapshots emitted before session_start`, async t => {
    const h = await harness(t);
    h.bus("wake_source_state", { source, activeCount: 1 });
    await h.ready();
    await h.command("continue-confirmed"); reason(h, "background-active");
    h.bus("wake_source_state", { source, activeCount: 0 });
    await h.emit("agent_settled"); await h.clock.advance(90_000);
    noAutomaticActions(h);
    assert.equal(h.snapshot().completionDelivery, "unknown");
  });
}

test("missing and malformed wake snapshots never imply a clear completion queue", async t => {
  const h = await harness(t); await h.ready();
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  for (const activeCount of [-1, NaN, "0", undefined]) {
    h.bus("wake_source_state", { source: "senpi-task", activeCount });
    await h.command("continue-confirmed"); reason(h, "background-active");
  }
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 0 });
  await h.reload(); await h.clock.advance(90_000);
  noAutomaticActions(h);
  assert.equal(h.snapshot().completionDelivery, "unknown");
});

test("explicit manual continuation needs acknowledgement, and claims before a void send", async t => {
  const h = await harness(t, { onSend: persisted => assert.deepEqual(persisted.attempts, ["user-1"]) });
  await h.ready();
  await h.command("continue"); reason(h, "confirmation-required");
  assert.equal(h.sent.length, 0);
  await h.command("continue-confirmed");
  reason(h, "manual-attempt-claimed");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, "muse-watch.continue");
  assert.deepEqual(h.sent[0].message.details, { sessionId: SID, admissionKey: "user-1" });
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  await h.command("continue-confirmed"); reason(h, "attempt-already-claimed");
  await h.command("resume"); await h.reload();
  await h.command("continue-confirmed"); reason(h, "attempt-already-claimed");
  assert.equal(h.sent.length, 1);
});

test("ambiguous send failure retains claim across reload and never retries", async t => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const h = await harness(t, { send() { throw new Error("admission uncertain"); } });
  await h.ready(); await h.command("continue-confirmed");
  reason(h, "send-outcome-unknown");
  await h.reload(); await h.command("continue-confirmed");
  reason(h, "attempt-already-claimed");
  assert.equal(h.sent.length, 1); assert.equal(errors.length, 1);
});

test("assistant activity, todo edits, and model changes cannot create another admission", async t => {
  const h = await harness(t); await h.ready(); await h.command("continue-confirmed");
  h.entries.push({ type: "message", id: "assistant-2", message: { role: "assistant", content: [] } });
  h.todos("in_progress"); await h.emit("agent_start"); await h.emit("agent_settled");
  h.state.model = { ...MODEL, provider: "cliproxy" };
  await h.command("continue-confirmed"); reason(h, "attempt-already-claimed");
  h.entries.push({ type: "message", id: "user-2", message: { role: "user", content: "A new instruction" } });
  await h.command("continue-confirmed"); assert.equal(h.sent.length, 2);
});

test("duplicate command aliases route status, pause and attempts to one live owner", async t => {
  const h = await harness(t); h.install(); await h.ready();
  assert.equal(h.clock.timers.size, 1);
  for (const occurrence of [1, 2]) {
    const before = h.notifications.length;
    await h.command("status", occurrence);
    assert.equal(h.notifications.length, before + 1);
    await h.command("pause", occurrence);
    assert.equal(h.snapshot().paused, true);
    await h.command("continue-confirmed", 3 - occurrence); reason(h, "paused");
    await h.command("resume", occurrence);
    assert.equal(h.snapshot().paused, false);
  }
  await h.command("continue-confirmed", 1);
  await h.command("continue-confirmed", 2); reason(h, "attempt-already-claimed");
  assert.equal(h.sent.length, 1);
  assert.equal(h.snapshot().attempts, 1);
  await h.emit("session_abort");
  await h.command("status", 1);
  assert.equal(h.snapshot().paused, true);
  assert.equal(h.clock.timers.size, 1);
});

for (const blocker of ["queued", "idle", "compacting"]) {
  test(`manual send refuses ${blocker} and does not consume a claim`, async t => {
    const h = await harness(t); await h.ready();
    h.state[blocker] = blocker !== "idle";
    await h.command("continue-confirmed"); noAutomaticActions(h);
    assert.equal(h.snapshot().attempts, 0);
    h.state[blocker] = blocker === "idle";
    await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
  });
}

test("unresolved direct admission and active tools block manual sends", async t => {
  const h = await harness(t); await h.ready();
  await h.emit("input", { source: "interactive", inputId: "pending" });
  await h.command("continue-confirmed"); reason(h, "input-pending");
  await h.emit("input_disposition", { inputId: "pending", disposition: "rejected" });
  await h.emit("tool_execution_start", { toolCallId: "tool" });
  await h.command("continue-confirmed"); reason(h, "agent-busy"); noAutomaticActions(h);
});

test("explicit resume cannot erase unresolved input holds, even after a user abort", async t => {
  const h = await harness(t); await h.ready();
  await h.emit("input", { source: "interactive", inputId: "pending-a" });
  await h.emit("input", { source: "interactive", inputId: "pending-b" });
  await h.emit("session_abort"); await h.command("resume");
  await h.command("continue-confirmed"); reason(h, "input-pending");
  await h.emit("input_disposition", { inputId: "pending-a", disposition: "started" });
  await h.command("continue-confirmed"); reason(h, "input-pending");
  await h.emit("input_disposition", { inputId: "pending-b", disposition: "rejected" });
  await h.command("continue-confirmed"); reason(h, "input-pending");
  h.state.idle = false; await h.emit("agent_start");
  await h.command("continue-confirmed"); reason(h, "agent-busy");
  h.state.idle = true; await h.emit("agent_settled");
  await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
});

test("started disposition retains admission while a later extension awaits before agent_start", { timeout: 2_000 }, async t => {
  const h = await harness(t); await h.ready();
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const dispositionEntered = new Promise(resolve => { entered = resolve; });
  h.pi.on("input_disposition", async event => {
    if (event.disposition === "started") { entered(); await blocked; }
  });
  await h.emit("input", { source: "interactive", inputId: "starting" });
  // AgentSession.prompt awaits the entire disposition emission before it
  // invokes _promptAgent, which changes isIdle and emits agent_start.
  const admission = h.emit("input_disposition", { inputId: "starting", disposition: "started" }).then(async () => {
    h.state.idle = false;
    await h.emit("agent_start");
  });
  await dispositionEntered;
  try {
    assert.equal(h.state.idle, true);
    await h.command("continue-confirmed");
    reason(h, "input-pending"); noAutomaticActions(h);
    assert.equal(h.snapshot().attempts, 0);
  } finally {
    release();
    await admission;
  }
  await h.command("continue-confirmed"); reason(h, "agent-busy");
  h.entries.push({ type: "message", id: "user-2", message: { role: "user", content: "New input" } });
  h.state.idle = true; await h.emit("agent_settled");
  await h.command("continue-confirmed");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.admissionKey, "user-2");
});

for (const queueVisible of [false, undefined, true]) {
  test(`queued disposition retains its hold unless the native queue blocks: ${queueVisible}`, async t => {
    const h = await harness(t); await h.ready();
    const queueGetter = h.ctx.hasPendingMessages;
    h.state.queued = queueVisible === true;
    if (queueVisible === undefined) delete h.ctx.hasPendingMessages;
    await h.emit("input", { source: "rpc", inputId: "queuing" });
    await h.emit("input_disposition", { inputId: "queuing", disposition: "queued" });
    if (queueVisible === true) {
      await h.command("continue-confirmed"); reason(h, "queued-messages");
    } else {
      h.ctx.hasPendingMessages = queueGetter;
      await h.command("continue-confirmed"); reason(h, "input-pending");
    }
    noAutomaticActions(h);
    h.state.idle = false; h.state.queued = false;
    await h.emit("agent_start");
    h.state.idle = true; await h.emit("agent_settled");
    await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
  });
}

test("agent_start only releases accepted holds, not other unresolved input", async t => {
  const h = await harness(t); await h.ready();
  await h.emit("input", { source: "interactive", inputId: "starting" });
  await h.emit("input", { source: "interactive", inputId: "unresolved" });
  await h.emit("input_disposition", { inputId: "starting", disposition: "started" });
  h.state.idle = false; await h.emit("agent_start");
  h.state.idle = true; await h.emit("agent_settled");
  await h.command("continue-confirmed"); reason(h, "input-pending");
  await h.emit("input_disposition", { inputId: "unresolved", disposition: "rejected" });
  await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
});

for (const disposition of ["handled", "rejected"]) {
  test(`a started input subsequently ${disposition} releases without agent_start`, async t => {
    const h = await harness(t); await h.ready();
    await h.emit("input", { source: "interactive", inputId: "cancelled" });
    await h.emit("input_disposition", { inputId: "cancelled", disposition: "started" });
    await h.command("continue-confirmed"); reason(h, "input-pending");
    await h.emit("input_disposition", { inputId: "cancelled", disposition });
    await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
  });
}

for (const event of ["session_before_switch", "session_before_fork"]) {
  test(`cancelled or invalid ${event} leaves commands, user abort and wake holds live`, async t => {
    const h = await harness(t); await h.ready();
    h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
    h.bus("continuation_hold_state", { source: "loop-guard", active: true });
    await h.emit(event);
    assert.equal(h.clock.timers.size, 1);
    await h.command("pause"); assert.equal(h.snapshot().paused, true);
    await h.command("resume");
    await h.emit("session_abort"); assert.equal(h.snapshot().paused, true);
    await h.command("resume");
    await h.command("continue-confirmed"); reason(h, "background-active");
    assert.equal(h.snapshot().wakeSources["senpi-task"], 1);
    h.bus("wake_source_state", { source: "senpi-task", activeCount: 0 });
    await h.command("continue-confirmed"); reason(h, "background-active");
    noAutomaticActions(h);
    h.bus("continuation_hold_state", { source: "loop-guard", active: false });
    await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
  });
}

test("committed shutdown disables timers and every retained command alias", async t => {
  const h = await harness(t); h.install(); await h.ready();
  await h.emit("session_shutdown", { reason: "reload" });
  assert.equal(h.clock.timers.size, 0);
  const before = h.entries.length;
  for (const occurrence of [1, 2]) {
    await h.command("resume", occurrence);
    await h.command("continue-confirmed", occurrence);
  }
  assert.equal(h.entries.length, before); noAutomaticActions(h);
});

test("continuation holds and armed Goal timers veto manual recovery", async t => {
  const h = await harness(t); await h.ready();
  h.bus("continuation_hold_state", { source: "loop-guard", active: true });
  await h.command("continue-confirmed"); reason(h, "background-active");
  h.bus("continuation_hold_state", { source: "loop-guard", active: false });
  h.bus("goal_continuation_timer_state", { armed: true });
  await h.command("continue-confirmed"); reason(h, "background-active");
  noAutomaticActions(h);
});

test("stream activity does not reset the four-warning session cap", async t => {
  const h = await harness(t); await h.ready(); h.state.idle = false;
  const before = h.notifications.length;
  for (let turn = 0; turn < 5; turn += 1) {
    await h.emit("agent_start"); await h.emit("after_provider_response");
    await h.clock.advance(40_000);
  }
  assert.equal(h.notifications.length, before + 4); noAutomaticActions(h);
});

test("persistence failure denies send and remains blocked, rather than swallowing disk errors", async t => {
  const h = await harness(t); await h.ready(); h.state.appendError = true;
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  await h.command("continue-confirmed"); reason(h, "persistence-failed");
  h.state.appendError = false;
  await h.command("continue-confirmed"); reason(h, "invalid-state");
  assert.equal(errors.length, 1); noAutomaticActions(h);
});

test("memory-only or not-yet-flushed sessions cannot claim durable attempts", async t => {
  const h = await harness(t); await h.ready(); h.state.file = undefined;
  await h.command("continue-confirmed"); reason(h, "non-durable-session");
  h.state.file = `/sessions/${SID}.jsonl`;
  h.state.entries = h.entries.filter(e => e.message?.role !== "assistant");
  h.state.branch = h.state.entries;
  await h.command("continue-confirmed"); reason(h, "non-durable-session"); noAutomaticActions(h);
});

test("a fork pre-event retains ownership until stale getters invalidate it", async t => {
  const h = await harness(t); await h.ready();
  await h.emit("session_before_fork"); assert.equal(h.clock.timers.size, 1);
  h.state.stale = true;
  await h.clock.advance(40_000);
  assert.equal(h.clock.timers.size, 0); noAutomaticActions(h);
});

for (const status of ["completed", "abandoned", "cancelled"]) {
  test(`legacy prose never revives explicit ${status} todos`, async t => {
    const h = await harness(t); await h.ready(); h.todos(status);
    h.pi.appendEntry("muse-watch.contract", { when: "the PR URL exists" });
    h.entries.push({ type: "message", message: { role: "assistant", content: "I'll stop when a PR exists." } });
    await h.emit("message_end", { message: h.entries.at(-1).message });
    await h.command("continue-confirmed"); reason(h, "no-open-todos");
    await h.clock.advance(90_000); noAutomaticActions(h);
    assert.equal(h.entries.filter(e => e.customType === "muse-watch.contract").length, 1);
  });
}

test("old PR links do not suppress actual open todos; prose alone creates none", async t => {
  const h = await harness(t);
  h.entries.push({ type: "message", message: { role: "assistant", content: "I'll stop when a PR exists. https://github.com/a/b/pull/1" } });
  await h.start(); await h.command("resume");
  await h.command("continue-confirmed"); reason(h, "no-open-todos");
  h.todos(); await h.command("continue-confirmed"); assert.equal(h.sent.length, 1);
  assert.equal(h.entries.filter(e => e.customType === "muse-watch.contract").length, 0);
});

test("todo state uses only the current branch, latest full snapshot and legacy structured details", async t => {
  const h = await harness(t); await h.ready();
  h.state.branch = h.entries.filter(e => e.customType !== "senpi.todo-state");
  await h.command("continue-confirmed"); reason(h, "no-open-todos");
  h.state.branch.push({ type: "message", message: { role: "toolResult", toolName: "todowrite", details: { todos: [{ content: "legacy", status: "pending" }] } } });
  await h.command("status"); assert.equal(h.snapshot().openTodos, 1);
  h.state.branch.push({ type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: [] } });
  await h.command("continue-confirmed"); reason(h, "no-open-todos"); noAutomaticActions(h);
});

function assistant(text, extra = {}) {
  return {
    id: extra.id ?? "asst-stop",
    role: "assistant",
    stopReason: extra.stopReason ?? "stop",
    content: extra.content ?? [{ type: "text", text }],
  };
}

async function endTurn(h, message) {
  await h.emit("agent_end", { messages: [message] });
  await h.emit("agent_settled");
}

test("classifier marks production dangling Muse stops as premature", () => {
  const cases = [
    "RED 테스트 실행 중 (`bash_17` — gradle test). 완료 알림 오면 RED 캡처하고 구현 들어갑니다.",
    "최종 빌드+테스트 실행 중 — 완료되면 결과 보고할게요.",
    "Fixing the leftover broken `widerScope` reference in MapApp.",
    "AccountSheet의 버튼성 Text들에 Role을 붙입니다.",
    "구현 방향을 정리했습니다. 바로 코드를 작성합니다.",
    "Build passes. The session image tool is key-blocked — so checking for a usable fallback before going procedural.",
    "아직 설치용 앱(exe)은 없고 웹 빌드만 있는 상태입니다. 바로 실행할 수 있게 띄워드리겠습니다.",
    "Phase 2 DAG가 출항했습니다 — 세 갑판이 조립되는 대로 검증하고 돌아오겠습니다.",
  ];
  for (const text of cases) {
    assert.equal(classifyAssistantStop(assistant(text)).kind, "premature", text);
  }
});

test("classifier leaves completed reports, I'll-stop-when, and user handoffs alone", () => {
  const cases = [
    "I'll stop when a PR URL exists.",
    "이루다급 챗봇 업그레이드 완료. 6/6 todos, goal complete.",
    "완료했습니다. 로컬 데모 피드를 확장했습니다.",
    "완료됐습니다. 초기 지도 뷰가 이제 전세계 칩을 보여줍니다.",
    "리뷰가 돌아오는 동안 대기합니다 — 결과 도착 즉시 후속 조치하겠습니다.",
    "앱 떴습니다. 브라우저에서 여기로 들어가시면 됩니다. 띄워볼까요?",
    "RUNTIME_SMOKE_OK",
  ];
  for (const text of cases) {
    assert.equal(classifyAssistantStop(assistant(text)).kind, "clean", text);
  }
  assert.equal(classifyAssistantStop(assistant("", { stopReason: "length" })).kind, "premature");
  assert.equal(classifyAssistantStop(assistant("x", {
    content: [{ type: "text", text: "writing" }, { type: "toolCall", name: "write", id: "c1" }],
  })).why, "stop-with-tool-calls");
});

test("premature dangling stop types continue once the TUI is idle", async t => {
  const h = await harness(t);
  await h.ready();
  await endTurn(h, assistant("Fixing the leftover broken widerScope reference in MapApp."));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content, "continue");
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp" });
  assert.equal(h.snapshot().reason, "auto-continue-sent");
  assert.equal(h.aborts.length, 0);
});

test("clean Muse stop does not type continue even with open todos", async t => {
  const h = await harness(t);
  await h.ready();
  await endTurn(h, assistant("완료했습니다. 검증 11/11 통과, PR을 열었습니다."));
  noAutomaticActions(h);
  await endTurn(h, assistant("I'll stop when a PR URL exists."));
  noAutomaticActions(h);
  await endTurn(h, assistant("RUNTIME_SMOKE_OK"));
  noAutomaticActions(h);
});

test("user abort and a live draft cancel a pending premature continue", async t => {
  const h = await harness(t);
  await h.ready();
  await h.emit("agent_end", { aborted: true, abortSource: "user", messages: [assistant("Fixing leftover state.")] });
  await h.emit("agent_settled");
  noAutomaticActions(h);
  await h.command("resume");
  h.state.draft = "user is typing";
  await endTurn(h, assistant("바로 코드를 작성합니다."));
  noAutomaticActions(h);
  assert.equal(h.snapshot().reason, "draft-not-known-empty");
});

test("known background work delays the typed continue until the source drops", async t => {
  const h = await harness(t);
  await h.ready();
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 1 });
  await endTurn(h, assistant("RED 테스트 실행 중. 완료 알림 오면 구현 들어갑니다."));
  noAutomaticActions(h);
  h.bus("wake_source_state", { source: "senpi-task", activeCount: 0 });
  await h.clock.advance(5_000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content, "continue");
});

test("premature stop continue is at most once per assistant id", async t => {
  const h = await harness(t);
  await h.ready();
  const message = assistant("so checking for a usable fallback before going procedural.");
  await endTurn(h, message);
  assert.equal(h.sent.length, 1);
  h.state.idle = true;
  await endTurn(h, message);
  assert.equal(h.sent.length, 1);
  await endTurn(h, assistant("바로 코드를 작성합니다.", { id: "asst-stop-2" }));
  assert.equal(h.sent.length, 2);
});

test("omo -p complete verdict does not type continue on dangling prose", async t => {
  const h = await harness(t, { inspect: () => "complete" });
  await h.ready();
  await endTurn(h, assistant("Fixing the leftover broken widerScope reference in MapApp."));
  noAutomaticActions(h);
  assert.equal(h.snapshot().reason, "inspect-complete");
  assert.equal(h.inspections.length, 1);
  assert.match(h.inspections[0].text, /Fixing the leftover/);
});

test("omo -p premature verdict types continue even without dangling prose", async t => {
  const h = await harness(t, { inspect: () => "premature" });
  await h.ready();
  await endTurn(h, assistant("The UI is written."));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].content, "continue");
  assert.equal(h.snapshot().stopVerdict.why, "omo-p");
});

test("structural leftover tool calls skip omo -p and still continue", async t => {
  const h = await harness(t);
  await h.ready();
  await endTurn(h, assistant("writing", {
    content: [{ type: "text", text: "writing" }, { type: "toolCall", name: "write", id: "c1" }],
  }));
  assert.equal(h.inspections.length, 0);
  assert.equal(h.sent[0].content, "continue");
});

test("inspect command is an ephemeral omo -p child", () => {
  const { bin, args } = buildInspectCommand("PROMPT", { model: { provider: "cliproxy", id: "muse-spark-1.3-contributor-free" } });
  assert.equal(bin, "omo");
  assert.equal(args[0], "-p");
  for (const flag of ["--no-session", "--no-extensions", "--no-tools", "--omo-senpi-disabled"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "PROMPT");
  assert.ok(args.includes("cliproxy/muse-spark-1.3-contributor-free"));
  assert.match(buildInspectPrompt({ stopReason: "stop", text: "hello", openTodos: 2 }), /PREMATURE or COMPLETE/);
  assert.equal(parseInspectVerdict("PREMATURE\n"), "premature");
  assert.equal(parseInspectVerdict("The turn is COMPLETE."), "complete");
  assert.equal(parseInspectVerdict("PREMATURE\nCOMPLETE"), "complete");
  assert.equal(parseInspectVerdict("nope"), "unknown");
  assert.equal(needsPrintInspect({ kind: "premature", why: "dangling-next-step" }), true);
  assert.equal(needsPrintInspect({ kind: "premature", why: "truncated" }), false);
});

test("OMO_MUSE_AUTO_CONTINUE=0 keeps premature inspection but does not type continue", async t => {
  const previous = process.env.OMO_MUSE_AUTO_CONTINUE;
  process.env.OMO_MUSE_AUTO_CONTINUE = "0";
  t.after(() => previous === undefined ? delete process.env.OMO_MUSE_AUTO_CONTINUE : (process.env.OMO_MUSE_AUTO_CONTINUE = previous));
  const h = await harness(t);
  await h.ready();
  await endTurn(h, assistant("Fixing the leftover broken widerScope reference."));
  noAutomaticActions(h);
  assert.equal(h.snapshot().automaticContinuation, "disabled");
});

test("malformed latest todo snapshot blocks stale earlier work, even on error tool results", async t => {
  const h = await harness(t); await h.ready();
  h.pi.appendEntry("senpi.todo-state", { phases: [{ tasks: "broken" }] });
  await h.command("continue-confirmed"); reason(h, "invalid-todos");
  h.todos();
  h.entries.push({ type: "message", message: { role: "toolResult", toolName: "todo", isError: true, details: { phases: [] } } });
  await h.command("continue-confirmed"); reason(h, "invalid-todos"); noAutomaticActions(h);
});
