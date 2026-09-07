import assert from "node:assert/strict";
import test from "node:test";

let moduleId = 0;

// A chronological clock, including timers created by timer callbacks. Raw and
// contained timers share Node's minimum 1ms timeout and cancellation semantics.
function virtualClock(t, now = 1_000_000) {
  let nextId = 0;
  const timers = new Map();
  const schedule = (fn, ms, interval = false) => {
    const id = ++nextId;
    timers.set(id, { fn, due: now + Math.max(1, ms), interval: interval ? ms : 0 });
    return id;
  };
  const clear = (id) => timers.delete(id);
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (fn, ms) => schedule(fn, ms));
  t.mock.method(globalThis, "setInterval", (fn, ms) => schedule(fn, ms, true));
  t.mock.method(globalThis, "clearTimeout", clear);
  t.mock.method(globalThis, "clearInterval", clear);
  return {
    timers,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next || next[1].due > target) break;
        const [id, timer] = next;
        now = timer.due;
        if (timer.interval) timer.due += timer.interval;
        else timers.delete(id);
        await timer.fn();
      }
      now = target;
    },
  };
}

async function harness(t, options = {}) {
  const clock = virtualClock(t, options.now);
  const env = {
    OMO_MUSE_WATCH: "1",
    OMO_MUSE_STALL_MS: "40000",
    OMO_MUSE_IDLE_TODO_MS: "8000",
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const { default: extension } = await import(`../muse-watch.js?test=${++moduleId}`);
  const handlers = new Map();
  const entries = [];
  const sent = [];
  const aborts = [];
  const notifications = [];
  const state = { idle: true, queued: false, model: { id: "muse-spark" } };
  const ctx = {
    get model() { return state.model; },
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    hasUI: true,
    ui: { notify: (...args) => notifications.push(args), setStatus() {} },
    sessionManager: { getBranch: () => entries },
    // Senpi's omitted source is "user"; system aborts must opt in.
    abort(source = "user") {
      aborts.push(source);
      state.idle = true;
      emit("agent_end", { aborted: true, abortSource: source, messages: [] });
    },
  };
  if (options.contained) {
    Object.assign(ctx, {
      setTimeout: globalThis.setTimeout,
      setInterval: globalThis.setInterval,
      clearTimer: globalThis.clearTimeout,
    });
  }
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    registerCommand() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(content, sendOptions) {
      sent.push({ content, options: sendOptions });
      return options.send?.();
    },
  };
  function emit(type, event = {}) { return handlers.get(type)?.({ type, ...event }, ctx); }
  function todos(status = "pending") {
    pi.appendEntry("senpi.todo-state", { phases: [{ tasks: [{ content: "task-1", status }] }] });
  }
  extension(pi);
  t.after(() => emit("session_shutdown", { reason: "quit" }));
  return { clock, state, ctx, pi, entries, sent, aborts, notifications, emit, todos, extension };
}

test("registers without trying to label a nonexistent transcript entry", async (t) => {
  const h = await harness(t);
  assert.doesNotThrow(() => h.extension({
    ...h.pi,
    setLabel(entryId) { throw new Error(`Entry ${entryId} not found`); },
  }));
});

test("registers when runtime actions are forbidden during extension loading", async (t) => {
  const h = await harness(t);
  assert.doesNotThrow(() => h.extension({
    ...h.pi,
    setLabel() { throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."); },
  }));
});

test("idle Muse follows unfinished todos only after the idle grace", async (t) => {
  const h = await harness(t);
  h.emit("session_start");
  h.todos();
  await h.clock.advance(9_999);
  assert.equal(h.sent.length, 0);
  await h.clock.advance(2);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options, undefined);
  assert.equal(h.aborts.length, 0);
});

test("session resume sends once, with cooldown and six-trip cap", async (t) => {
  const h = await harness(t);
  h.todos();
  h.emit("session_start");
  h.emit("agent_end", { messages: [] });
  await h.clock.advance(1);
  assert.equal(h.sent.length, 1);
  await h.clock.advance(59_999);
  assert.equal(h.sent.length, 1);
  await h.clock.advance(1);
  assert.equal(h.sent.length, 2);
  await h.clock.advance(600_000);
  assert.equal(h.sent.length, 6);
});

for (const model of [{ id: "gpt-6" }, undefined]) {
  test(`does not send or abort for ${model?.id ?? "unknown model"}`, async (t) => {
    const h = await harness(t);
    h.state.model = model;
    h.todos();
    h.emit("session_start");
    h.emit("agent_end", { messages: [] });
    await h.clock.advance(70_000);
    h.state.idle = false;
    await h.clock.advance(70_000);
    assert.equal(h.sent.length, 0);
    assert.equal(h.aborts.length, 0);
  });
}

test("known non-Muse does not persist a Muse contract", async (t) => {
  const h = await harness(t);
  h.state.model = { id: "gpt-6" };
  const message = { role: "assistant", content: "I'll stop when the PR exists." };
  h.entries.push({ type: "message", message });
  h.emit("session_start");
  h.emit("message_end", { message });
  assert.equal(h.entries.filter((entry) => entry.customType === "muse-watch.contract").length, 0);
});

test("known history and omp model access remain supported", async (t) => {
  const h = await harness(t);
  h.state.model = undefined;
  h.entries.push({ type: "model_change", modelId: "muse-spark" });
  h.todos();
  h.emit("session_start");
  await h.clock.advance(1);
  assert.equal(h.sent.length, 1);
  h.ctx.models = { current: () => ({ id: "gpt-6" }) };
  await h.clock.advance(70_000);
  assert.equal(h.sent.length, 1);
});

test("silent Muse aborts as system at the stall boundary then follows up", async (t) => {
  const h = await harness(t);
  h.state.idle = false;
  h.emit("session_start");
  await h.clock.advance(39_999);
  assert.equal(h.aborts.length, 0);
  await h.clock.advance(1);
  assert.deepEqual(h.aborts, ["system"]);
  await h.clock.advance(1_199);
  assert.equal(h.sent.length, 0);
  await h.clock.advance(1);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp" });
});

test("the first stall does not require a previous-trip cooldown", async (t) => {
  const h = await harness(t, { now: 0 });
  h.state.idle = false;
  h.emit("session_start");
  await h.clock.advance(40_000);
  assert.equal(h.aborts.length, 1);
});

test("active overlapping tools survive silence until all tools finish", async (t) => {
  const h = await harness(t);
  h.state.idle = false;
  h.emit("session_start");
  h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
  h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" });
  await h.clock.advance(90_000);
  assert.equal(h.aborts.length, 0);
  h.emit("tool_execution_end", { toolCallId: "a", toolName: "bash" });
  await h.clock.advance(90_000);
  assert.equal(h.aborts.length, 0);
  h.emit("tool_execution_end", { toolCallId: "b", toolName: "bash" });
  await h.clock.advance(39_999);
  assert.equal(h.aborts.length, 0);
  await h.clock.advance(1);
  assert.equal(h.aborts.length, 1);
});

for (const abortEvent of ["agent_end", "session_abort"]) {
  test(`${abortEvent} user abort suppresses idle ticks until a new run`, async (t) => {
    const h = await harness(t);
    h.emit("session_start");
    h.todos();
    h.emit(abortEvent, { aborted: true, abortSource: "user", messages: [] });
    await h.clock.advance(120_000);
    assert.equal(h.sent.length, 0);
    h.emit("agent_start");
    await h.clock.advance(10_001);
    assert.equal(h.sent.length, 1);
  });
}

test("user abort cancels an already scheduled premature follow-up", async (t) => {
  const h = await harness(t);
  h.emit("session_start");
  h.todos();
  h.state.idle = false;
  h.emit("agent_end", { messages: [] });
  h.state.idle = true;
  h.emit("session_abort");
  await h.clock.advance(120_000);
  assert.equal(h.sent.length, 0);
});

for (const contained of [false, true]) {
  for (const stalled of [false, true]) {
    test(`shutdown clears ${contained ? "contained" : "raw"} timers with ${stalled ? "stall" : "todo"} kick pending`, async (t) => {
      const h = await harness(t, { contained });
      if (stalled) h.state.idle = false;
      else h.todos();
      h.emit("session_start");
      if (stalled) await h.clock.advance(40_000);
      h.emit("session_shutdown", { reason: "reload" });
      assert.equal(h.clock.timers.size, 0);
      await h.clock.advance(120_000);
      assert.equal(h.sent.length, 0);
    });
  }
}

test("queued messages suppress idle continuation", async (t) => {
  const h = await harness(t);
  h.state.queued = true;
  h.todos();
  h.emit("session_start");
  await h.clock.advance(70_000);
  assert.equal(h.sent.length, 0);
  h.state.queued = false;
  await h.clock.advance(5_001);
  assert.equal(h.sent.length, 1);
});

for (const change of ["queued", "model", "completed"]) {
  test(`scheduled follow-up rechecks ${change} before delivery`, async (t) => {
    const h = await harness(t);
    h.emit("session_start");
    h.todos();
    h.state.idle = false;
    h.emit("agent_end", { messages: [] });
    if (change === "queued") h.state.queued = true;
    if (change === "model") h.state.model = { id: "gpt-6" };
    if (change === "completed") h.todos("completed");
    await h.clock.advance(400);
    assert.equal(h.sent.length, 0);
  });
}

for (const change of ["queued", "model", "user-abort"]) {
  test(`stall recovery rechecks ${change} before delivery`, async (t) => {
    const h = await harness(t);
    h.state.idle = false;
    h.emit("session_start");
    await h.clock.advance(40_000);
    if (change === "queued") h.state.queued = true;
    if (change === "model") h.state.model = { id: "gpt-6" };
    if (change === "user-abort") h.emit("session_abort");
    await h.clock.advance(1_200);
    assert.equal(h.sent.length, 0);
  });
}

test("delivery uses current idle state rather than the agent_end snapshot", async (t) => {
  const h = await harness(t);
  h.emit("session_start");
  h.todos();
  h.state.idle = false;
  h.emit("agent_end", { messages: [] });
  h.state.idle = true;
  await h.clock.advance(400);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options, undefined);
});

test("willRetry protects backoff but the next agent_start re-arms stall detection", async (t) => {
  const h = await harness(t);
  h.state.idle = false;
  h.emit("session_start");
  h.todos();
  h.emit("agent_end", { willRetry: true, messages: [{ role: "assistant", stopReason: "error" }] });
  await h.clock.advance(90_000);
  assert.equal(h.aborts.length, 0);
  assert.equal(h.sent.length, 0);
  h.emit("agent_start");
  await h.clock.advance(40_000);
  assert.equal(h.aborts.length, 1);
});

test("willRetry protects idle gaps and settlement releases the hold", async (t) => {
  const h = await harness(t);
  h.emit("session_start");
  h.todos();
  h.emit("agent_end", { willRetry: true, messages: [] });
  await h.clock.advance(90_000);
  assert.equal(h.sent.length, 0);
  h.emit("agent_settled");
  await h.clock.advance(10_001);
  assert.equal(h.sent.length, 1);
});

test("a provider response does not reset the session's four-stall cap", async (t) => {
  const h = await harness(t);
  h.emit("session_start");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    h.state.idle = false;
    h.emit("agent_start");
    h.emit("after_provider_response", { status: 200, headers: {} });
    await h.clock.advance(65_000);
  }
  assert.equal(h.aborts.length, 4);
  assert.equal(h.sent.length, 4);
});

for (const [when, expected] of [
  ["the goal is met and committed with no PR/merge", 0],
  ["the fix is committed without a pull request", 0],
  ["the fix is committed; do not open a PR", 0],
  ["the fix is committed; a PR is not required", 0],
  ["the fix is committed; PR is unnecessary", 0],
  ["the fix is committed; never create a PR", 0],
  ["the fix is committed; pull request not needed", 0],
  ["the fix is committed, not raising any PR", 0],
  ["the fix is committed; don't raise a pull request", 0],
  ["the fix is committed; don’t submit a PR URL", 0],
  ["the fix is committed without another PR URL", 0],
  ["the fix is committed without an PR URL", 0],
  ["the fix is committed; PR URL is not required", 0],
  ["a PR is not required; never create a pull request", 0],
  ["a PR is not required, but the existing PR URL is available", 1],
  ["PR is unnecessary, but the existing PR URL is available", 1],
  ["never create a PR, but the existing PR URL is available", 1],
  ["the PR URL is available", 1],
  ["the PR has no failing checks", 1],
  ["the PR URL is available with no merge", 1],
  ["the PR URL is available without opening another PR", 1],
]) {
  test(`PR requirement classification: ${when}`, async (t) => {
    const h = await harness(t);
    h.pi.appendEntry("muse-watch.contract", { when });
    h.emit("session_start");
    await h.clock.advance(10_001);
    assert.equal(h.sent.length, expected);
  });
}

test("explicit no-PR contract does not suppress open todo recovery", async (t) => {
  const h = await harness(t);
  h.pi.appendEntry("muse-watch.contract", { when: "committed with no PR/merge" });
  h.todos();
  h.emit("session_start");
  await h.clock.advance(1);
  assert.equal(h.sent.length, 1);
});
