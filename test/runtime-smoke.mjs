#!/usr/bin/env node
/**
 * Integration checks through the installed OmO launcher, Senpi loader and JSONL RPC.
 * Run: node test/runtime-smoke.mjs (OMO_BIN may name another installed launcher).
 * No extension API doubles, user state, external providers, terminal panes or sleeps.
 * Linux TUI coverage uses util-linux script and a read-only event observer loaded
 * by the real extension loader. Missing runtime/PTY support is a failure, not a skip.
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const candidate = await realpath(fileURLToPath(new URL("../muse-watch.js", import.meta.url)));
const candidateSource = await readFile(candidate, "utf8");
const candidateHash = createHash("sha256").update(candidateSource).digest("hex");
const requestedBin = process.env.OMO_BIN || "omo";
const bin = requestedBin.includes("/") && !isAbsolute(requestedBin) ? resolve(requestedBin) : requestedBin;
const modelId = "muse-spark-1.3-contributor-free";
const stateType = "muse-watch.state";
const todoType = "senpi.todo-state";
const timeoutMs = 30_000;
const root = await mkdtemp(join(tmpdir(), "muse-watch-runtime-"));
const agentDir = join(root, "agent");
const home = join(root, "home");
const cwd = join(root, "project");
const clients = new Set();
const httpEvents = new EventEmitter();
const requests = [];
let expectedRequest;
let serverError;
const observerServer = createSocketServer();

// Deliberately do not inherit provider keys, credential paths, session IDs,
// shared-host sockets, NODE_OPTIONS, proxies, Herdr targets or task-child flags.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  OMO_CODING_AGENT_DIR: agentDir,
  SENPI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
  OMO_MUSE_WATCH: "1",
  OMO_MUSE_INSPECT: "0",
  OMO_ENABLE_SHARED_HOST: "0",
  OMO_RPC_CLIENT_CAPABILITIES: "extension_events",
  NO_COLOR: "1",
  TERM: "xterm-256color",
  PI_TUI_KEYBOARD_PROTOCOL: "0",
};

function signal(emitter, event, predicate, label) {
  let cancel;
  const promise = new Promise((resolveSignal, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, onEvent);
      emitter.off("failure", onFailure);
    };
    const onFailure = error => { cleanup(); reject(error); };
    const onEvent = value => {
      try {
        if (!predicate(value)) return;
        cleanup(); resolveSignal(value);
      } catch (error) { onFailure(error); }
    };
    const timer = setTimeout(() => onFailure(new Error(`Timed out awaiting ${label}`)), timeoutMs);
    cancel = () => { cleanup(); resolveSignal(undefined); };
    emitter.on(event, onEvent);
    emitter.on("failure", onFailure);
  });
  // The caller still awaits/rejects this promise; suppress only the transient
  // unhandled-rejection window when another signal in the same action fails.
  void promise.catch(() => {});
  return { promise, cancel: () => cancel() };
}

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const record = { method: request.method, url: request.url, body };
    requests.push(record);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.ok(expectedRequest, "Unintended provider request");
    assert.equal(body.model, modelId);
    const validate = expectedRequest;
    expectedRequest = undefined;
    await validate(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "RUNTIME_SMOKE_OK" }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "runtime-smoke", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
    httpEvents.emit("request", record);
  } catch (error) {
    serverError = error;
    httpEvents.emit("failure", error);
    for (const client of clients) client.fail(error);
    response.writeHead(500);
    response.end(JSON.stringify({ error: { message: String(error), type: "runtime_smoke_failure" } }));
  }
});

function launchArgs(sessionFile) {
  return [
    "--offline", "--no-extensions", "-e", candidate,
    "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-tools",
    "--omo-senpi-disabled", "--omo-senpi-onboarding-disabled", "--omo-senpi-memory-disabled",
    "--no-model-fallback", "--no-recommended-models", "--no-nested-agents", "--pi-rules-disabled", "--ttsr-disabled",
    "--system-prompt", "Local runtime regression fixture. Reply with the server sentinel.",
    "--provider", "muse", "--model", modelId, "--thinking", "off",
    "--session-dir", join(root, "sessions"),
    ...(sessionFile ? ["--session", sessionFile] : ["--no-session"]),
  ];
}

class Rpc {
  constructor(sessionFile, extraExtensions = []) {
    this.events = new EventEmitter();
    this.log = [];
    this.stderr = "";
    this.sequence = 0;
    this.allowedTurns = 0;
    this.startedTurns = 0;
    const args = ["--mode", "rpc", ...launchArgs(sessionFile), ...extraExtensions.flatMap(path => ["-e", path])];
    this.child = spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    clients.add(this);
    this.child.once("error", error => this.fail(error));
    this.child.stdin.on("error", error => this.fail(error));
    this.child.stderr.on("data", chunk => { this.stderr += chunk; });
    this.closed = new Promise(resolveClose => this.child.once("close", (code, terminationSignal) => {
      this.exit = { code, signal: terminationSignal };
      if (!this.stopping || code !== 0) this.fail(new Error(`OmO exited ${JSON.stringify(this.exit)}\n${this.stderr}`));
      this.events.emit("closed", this.exit);
      resolveClose(this.exit);
    }));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      try {
        const event = JSON.parse(line);
        this.log.push(event);
        if (event.type === "agent_start") {
          this.startedTurns++;
          assert.ok(this.startedTurns <= this.allowedTurns, `Unintended agent turn: ${JSON.stringify(event)}`);
        }
        assert.ok(!["extension_error", "rpc_error"].includes(event.type), JSON.stringify(event));
        this.events.emit("record", event);
      } catch (error) { this.fail(error); }
    });
  }

  fail(error) {
    this.failure ??= error;
    this.events.emit("failure", error);
  }

  check() {
    if (this.failure) throw new Error(`${this.failure.stack}\nOmO stderr:\n${this.stderr}\nRecent RPC:\n${this.log.slice(-12).map(e => JSON.stringify(e)).join("\n")}`);
    if (serverError) throw serverError;
  }

  wait(predicate, label) {
    this.check();
    return signal(this.events, "record", predicate, label);
  }

  async request(type, data = {}) {
    this.check();
    const id = `smoke-${++this.sequence}`;
    const response = this.wait(e => e.type === "response" && e.id === id, `${type} response (${id})`);
    this.child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const event = await response.promise;
    this.check();
    assert.equal(event.command, type);
    assert.equal(event.success, true, JSON.stringify(event));
    return event.data;
  }

  watchState() {
    return this.wait(e => e.type === "extension_event" && e.name === "muse_watch_state", "muse_watch_state RPC event");
  }

  async command(args, commandName = "muse-watch") {
    const state = this.watchState();
    try {
      const [response, event] = await Promise.all([
        this.request("prompt", { message: `/${commandName} ${args}` }), state.promise,
      ]);
      assert.equal(response.disposition, "handled", "Slash command must not enter the model loop");
      return event.data;
    } finally { state.cancel(); }
  }

  async status(commandName = "muse-watch") {
    const notification = this.wait(e => e.type === "extension_ui_request" && e.method === "notify" && e.notifyType === "info", "JSON status display");
    try {
      const [snapshot, event] = await Promise.all([this.command("status", commandName), notification.promise]);
      assert.deepEqual(JSON.parse(event.message), snapshot, "Displayed JSON and machine-readable state must agree");
      return snapshot;
    } finally { notification.cancel(); }
  }

  async pause() {
    const persisted = this.wait(e => e.type === "entry_appended" && e.entry.customType === stateType && e.entry.data.paused === true, "durable pause entry");
    try {
      const [state, event] = await Promise.all([this.command("pause"), persisted.promise]);
      assert.equal(state.paused, true);
      assert.equal(event.entry.data.sessionId, state.sessionId);
      return event.entry;
    } finally { persisted.cancel(); }
  }

  async assertQuiet(expectedMessageCount) {
    const state = await this.request("get_state");
    assert.equal(state.isStreaming, false);
    assert.equal(state.pendingMessageCount, 0);
    assert.deepEqual(state.steering, []);
    assert.deepEqual(state.followUp, []);
    if (expectedMessageCount !== undefined) assert.equal(state.messageCount, expectedMessageCount);
    this.check();
  }

  async stop() {
    this.stopping = true;
    if (!this.exit) {
      const closed = signal(this.events, "closed", () => true, "graceful OmO RPC EOF shutdown");
      this.child.stdin.end();
      try { await closed.promise; }
      finally { closed.cancel(); }
    }
    await this.closed;
    clients.delete(this);
    this.lines.close();
    this.check();
    assert.equal(this.exit.code, 0);
  }
}

async function entries(path) {
  return (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

async function fixture(name, { todos = [], oldPr = false } = {}) {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const result = [{ type: "session", version: 3, id: sessionId, timestamp, cwd }];
  let parentId = null;
  const add = entry => {
    const id = randomUUID().replaceAll("-", "").slice(0, 8);
    result.push({ ...entry, id, parentId, timestamp });
    parentId = id;
  };
  add({ type: "model_change", provider: "muse", modelId });
  add({ type: "message", message: { role: "user", content: [{ type: "text", text: "RUNTIME_FIXTURE_USER" }], timestamp: 1 } });
  // A real pre-existing assistant entry makes appendEntry durability observable,
  // unlike a new/unflushed session whose custom entries may remain in memory.
  add({ type: "message", message: {
    role: "assistant", content: [{ type: "text", text: `I'll stop when a PR URL exists.${oldPr ? " https://github.com/example/old/pull/1" : ""}` }],
    api: "openai-completions", provider: "muse", model: modelId, stopReason: "stop", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } });
  add({ type: "custom", customType: "muse-watch.contract", data: { when: "a PR URL exists", at: 1 } });
  add({ type: "custom", customType: todoType, data: { schema: "v2", phases: [{ name: "Fixture", tasks: todos }] } });
  const path = join(root, `${name}.jsonl`);
  await writeFile(path, `${result.map(e => JSON.stringify(e)).join("\n")}\n`);
  return { path, sessionId };
}

async function exerciseTui() {
  const { stdout } = await promisify(execFile)("script", ["--version"], { env, timeout: timeoutMs });
  assert.match(stdout, /util-linux/, "The real TUI scenario requires util-linux script");
  const data = await fixture("tui-manual", { todos: [{ content: "RUNTIME_TUI_PENDING", status: "pending" }] });
  const before = await entries(data.path);
  const admissionKey = before.findLast(e => e.type === "message" && e.message.role === "user").id;
  const observerPath = join(root, "tui-observer.mjs");
  const socketPath = join(root, "observer.sock");
  // This fixture only subscribes and forwards. It never writes an editor, emits
  // lifecycle events, alters context, registers commands or invokes agent APIs.
  await writeFile(observerPath, `import { createConnection } from "node:net";
export default async function (pi) {
  const socket = createConnection(process.env.RUNTIME_SMOKE_SOCKET);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const send = event => socket.write(JSON.stringify(event) + "\\n");
  const off = pi.events.on("muse_watch_state", data => send({ type: "watch", data }));
  pi.on("session_start", (_event, ctx) => send({ type: "ready", mode: ctx.mode, sessionId: ctx.sessionManager.getSessionId() }));
  for (const type of ["agent_start", "agent_settled", "message_end"]) pi.on(type, event => send(event));
  pi.on("session_shutdown", () => { off(); socket.end(JSON.stringify({ type: "shutdown" }) + "\\n"); });
}
`);
  const events = new EventEmitter();
  const tui = {
    log: [], stderr: "", startedTurns: 0, allowedTurns: 0, isTui: true,
    fail(error) { this.failure ??= error; events.emit("failure", error); },
  };
  let observerSocket;
  observerServer.once("connection", socket => {
    observerSocket = socket;
    socket.on("error", error => tui.fail(error));
    const lines = createInterface({ input: socket });
    lines.on("line", line => {
      try {
        const event = JSON.parse(line);
        tui.log.push(event);
        if (event.type === "agent_start") {
          tui.startedTurns++;
          assert.ok(tui.startedTurns <= tui.allowedTurns, "Unintended TUI agent turn");
        }
        events.emit("record", event);
      } catch (error) { tui.fail(error); }
    });
  });
  await new Promise((resolveListen, reject) => {
    observerServer.once("error", reject);
    observerServer.listen(socketPath, resolveListen);
  });
  const wait = (predicate, label) => {
    if (tui.failure) throw tui.failure;
    return signal(events, "record", predicate, label);
  };
  const ready = wait(e => e.type === "ready", "real TUI session_start");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const shellCommand = `stty rows 40 cols 120; exec ${[bin, ...launchArgs(data.path), "-e", observerPath].map(quote).join(" ")}`;
  tui.child = spawn("script", ["--quiet", "--return", "--flush", "--command", shellCommand, "/dev/null"], {
    cwd, env: { ...env, RUNTIME_SMOKE_SOCKET: socketPath }, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  clients.add(tui);
  tui.child.on("error", error => tui.fail(error));
  tui.child.stdin.on("error", error => tui.fail(error));
  tui.child.stderr.on("data", chunk => { tui.stderr += chunk; });
  let tail = "";
  tui.child.stdout.on("data", chunk => {
    tui.stderr = (tui.stderr + chunk).slice(-20_000);
    // Minimal terminal replies, not application events or simulated extension
    // state. Match queries even when the OS splits them between output chunks.
    const output = tail + chunk;
    for (const match of output.matchAll(/\u001b\[6n|\u001b\[c|\u001b\[\?u/g)) {
      tui.child.stdin.write(match[0] === "\x1b[6n" ? "\x1b[1;1R" : match[0] === "\x1b[c" ? "\x1b[?1;2c" : "\x1b[?0u");
    }
    const escape = output.lastIndexOf("\x1b");
    tail = escape >= 0 && !/[A-Za-z]$/.test(output.slice(escape)) ? output.slice(escape) : "";
  });
  tui.closed = new Promise(resolveClose => tui.child.once("close", (code, terminationSignal) => {
    tui.exit = { code, signal: terminationSignal };
    if (!tui.stopping || code !== 0) tui.fail(new Error(`TUI exited ${JSON.stringify(tui.exit)}`));
    events.emit("closed", tui.exit);
    observerSocket?.destroy();
    resolveClose(tui.exit);
  }));
  async function command(name, reason) {
    const state = wait(e => e.type === "watch", `/muse-watch ${name} real TUI state`);
    tui.child.stdin.write(`/muse-watch ${name}\r`);
    try {
      const event = await state.promise;
      assert.equal(event.data.reason, reason);
      return event.data;
    } finally { state.cancel(); }
  }
  try {
    const event = await ready.promise;
    assert.equal(event.mode, "tui");
    assert.equal(event.sessionId, data.sessionId);
  } finally { ready.cancel(); }
  const resumed = await command("resume", "observing-only");
  assert.equal(resumed.draftKnownEmpty, true);
  assert.equal(resumed.supportedModel, true);
  assert.equal(resumed.openTodos, 1);
  assert.equal(resumed.completionDelivery, "unknown");
  await command("continue", "confirmation-required");
  assert.equal(requests.length, 0);
  expectedRequest = async body => {
    const persisted = await entries(data.path);
    const state = persisted.filter(e => e.customType === stateType).at(-1).data;
    assert.deepEqual(state.attempts, [admissionKey], "At-most-once claim must be on disk BEFORE HTTP request");
    assert.ok(Array.isArray(body.messages));
  };
  const wire = signal(httpEvents, "request", () => true, "confirmed TUI HTTP request");
  const settled = wait(e => e.type === "agent_settled", "confirmed TUI agent_settled");
  const assistant = wait(e => e.type === "message_end" && e.message?.role === "assistant", "confirmed TUI assistant message_end");
  tui.allowedTurns = 1;
  try {
    const [state, , , end] = await Promise.all([
      command("continue-confirmed", "manual-attempt-claimed"), wire.promise, settled.promise, assistant.promise,
    ]);
    assert.equal(state.attempts, 1);
    assert.equal(end.message.stopReason, "stop");
    assert.equal(end.message.content.filter(c => c.type === "text").map(c => c.text).join(""), "RUNTIME_SMOKE_OK");
  } finally { wire.cancel(); settled.cancel(); assistant.cancel(); }
  // Runtime message persistence is queued independently of the HTTP request;
  // agent_settled is the authoritative boundary for checking its durable entry.
  const continuation = (await entries(data.path)).filter(e => e.type === "custom_message" && e.customType === "muse-watch.continue");
  assert.equal(continuation.length, 1);
  assert.deepEqual(continuation[0].details, { sessionId: data.sessionId, admissionKey });
  assert.ok(JSON.stringify(requests[0].body.messages).includes(continuation[0].content), "Actual provider payload must include the submitted custom message");
  const duplicate = await command("continue-confirmed", "attempt-already-claimed");
  assert.equal(duplicate.attempts, 1);
  assert.equal(duplicate.nativeQueueEmpty, true);
  assert.equal(duplicate.idle, true);
  assert.equal(duplicate.openTodos, 1);
  assert.equal(tui.startedTurns, 1);
  assert.equal(requests.length, 1);
  const closed = signal(events, "closed", () => true, "real TUI /quit shutdown");
  tui.stopping = true;
  tui.child.stdin.write("/quit\r");
  try { await closed.promise; }
  finally { closed.cancel(); }
  await tui.closed;
  if (tui.failure) throw tui.failure;
  assert.equal(tui.exit.code, 0);
  clients.delete(tui);
  const final = await entries(data.path);
  assert.equal(final.filter(e => e.type === "message" && e.message.role === "user").length, 1, "Custom continuation cannot create another user admission");
  assert.equal(final.filter(e => e.type === "custom_message" && e.customType === "muse-watch.continue").length, 1);
  pass("real CLI PTY/TUI: empty draft, explicit acknowledgement, durable claim before one local HTTP continuation, duplicate admission refused");
}

function pass(name) { console.log(`PASS ${name}`); }

try {
  await Promise.all([agentDir, home, cwd].map(path => mkdir(path, { recursive: true })));
  // OmO injects its bundled plugin even with --no-extensions. In this engine,
  // global component flags are read during registration (before CLI flag values
  // are applied). The real onboarding marker also protects the reload path.
  const onboardingDir = join(agentDir, "omo-senpi", "omo-native");
  await mkdir(onboardingDir, { recursive: true });
  await writeFile(join(onboardingDir, "onboarding-completed"), JSON.stringify({ completedAt: new Date().toISOString(), version: 1 }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, experimental: { sharedHost: false } }));
  await writeFile(join(agentDir, "omo.json"), JSON.stringify({ memory: { enabled: false } }));
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const models = [
    { id: modelId, name: "Runtime exact Muse" },
    { id: `${modelId}-preview`, name: "Runtime suffix decoy" },
    { id: "other-model", name: modelId },
  ].map(model => ({ ...model, contextWindow: 128000, maxTokens: 256, reasoning: false }));
  // A public synthetic placeholder satisfies the registry's configured-provider
  // check. It is not a credential; all provider URLs are this loopback server.
  const provider = { api: "openai-completions", baseUrl, apiKey: "runtime-smoke-not-a-credential", authHeader: false, models };
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { muse: provider, cliproxy: provider, "muse-spark-decoy": provider } }));
  const { stdout: version } = await promisify(execFile)(bin, ["--version"], { cwd, env, timeout: timeoutMs });
  console.log(`Runtime: ${version.trim()}`);
  assert.match(version, /omo.*engine: senpi/i, "OMO_BIN must be an installed OmO launcher");

  // Scenarios below use only actual RPC commands and emitted loader/UI events.
  const rpc = new Rpc();
  const protocol = await rpc.request("get_protocol_info");
  assert.equal(protocol.mode, "classic");
  assert.ok(protocol.capabilities.includes("extension_events"), "Runtime must support extension RPC events");
  const commands = (await rpc.request("get_commands")).commands;
  const command = commands.filter(c => c.name === "muse-watch");
  assert.equal(command.length, 1);
  assert.equal(command[0].source, "extension");
  assert.equal(await realpath(command[0].sourceInfo.path), candidate);
  const surfaces = await rpc.request("get_loaded_surfaces");
  const loaded = surfaces.extensions.filter(e => e.path === candidate);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].enabled, true);
  await rpc.assertQuiet(0);
  pass("startup loader discovery and unique candidate command registration (isolated ephemeral RPC)");
  const initial = await rpc.status();
  assert.equal(initial.paused, true);
  assert.equal(initial.openTodos, 0);
  assert.equal(initial.supportedModel, true);
  assert.equal(initial.draftKnownEmpty, false);
  assert.equal(initial.completionDelivery, "unknown");
  assert.equal(initial.automaticContinuation, "premature-stop-continue");
  assert.equal(initial.automaticAbort, false);
  await rpc.command("resume");
  for (const [providerName, id, supported] of [
    ["cliproxy", modelId, true],
    ["muse", `${modelId}-preview`, false],
    ["muse", "other-model", false],
    ["muse-spark-decoy", modelId, false],
    ["muse", modelId, true],
  ]) {
    await rpc.request("set_model", { provider: providerName, modelId: id });
    const live = (await rpc.request("get_state")).model;
    assert.deepEqual({ provider: live.provider, id: live.id }, { provider: providerName, id });
    assert.equal(live.baseUrl, baseUrl, "All live model routes must stay on loopback");
    const state = await rpc.command("continue-confirmed");
    assert.deepEqual(state.model, { provider: providerName, id });
    assert.equal(state.supportedModel, supported);
    assert.equal(state.reason, supported ? "draft-not-known-empty" : "unsupported-model");
    assert.equal(state.attempts, 0);
  }
  await rpc.assertQuiet(0);
  await rpc.stop();
  pass("exact live provider/model gating, suffix/name/provider decoys, and RPC editor fail-closed");

  const open = await fixture("open-todos", { oldPr: true, todos: [
    { content: "RUNTIME_PENDING", status: "pending" },
    { content: "RUNTIME_ACTIVE", status: "in_progress" },
    { content: "RUNTIME_COMPLETED", status: "completed" },
    { content: "RUNTIME_ABANDONED", status: "abandoned" },
  ] });
  const resumed = new Rpc(open.path);
  const loadedState = await resumed.status();
  assert.equal(loadedState.sessionId, open.sessionId);
  assert.equal(loadedState.openTodos, 2, "Old PR must not hide explicit pending/in-progress todos");
  assert.equal(loadedState.paused, true);
  await resumed.command("resume");
  for (const commandName of ["continue", "continue-confirmed"]) {
    const state = await resumed.command(commandName);
    assert.equal(state.reason, "draft-not-known-empty");
    assert.equal(state.draftKnownEmpty, false);
    assert.equal(state.openTodos, 2);
    assert.equal(state.attempts, 0);
  }
  await resumed.assertQuiet(2);
  pass("explicit todo JSON display and both continuation commands reject unknown RPC draft state");

  const pauseEntry = await resumed.pause();
  assert.deepEqual((await entries(open.path)).find(e => e.id === pauseEntry.id), pauseEntry);
  assert.equal((await resumed.command("continue-confirmed")).reason, "paused");
  assert.equal((await resumed.status()).paused, true, "Read-only status must not clear pause");
  const reloaded = resumed.watchState();
  try {
    await resumed.request("reload");
    assert.equal((await reloaded.promise).data.paused, true);
  } finally { reloaded.cancel(); }
  assert.equal((await resumed.status()).paused, true);
  assert.equal((await resumed.command("continue-confirmed")).reason, "paused");
  await resumed.assertQuiet(2);
  await resumed.stop();
  const durableState = (await entries(open.path)).filter(e => e.customType === stateType).at(-1).data;
  assert.equal(durableState.sessionId, open.sessionId);
  assert.equal(durableState.paused, true);
  assert.deepEqual(durableState.attempts, []);
  pass("pause is actually appended to pre-existing session JSONL and survives real RPC reload");

  const restarted = new Rpc(open.path);
  const restartState = await restarted.status();
  assert.equal(restartState.sessionId, open.sessionId);
  assert.equal(restartState.paused, true);
  assert.equal(restartState.openTodos, 2);
  assert.equal((await restarted.command("continue-confirmed")).reason, "paused");
  await restarted.assertQuiet(2);
  assert.equal(requests.length, 0, "No startup, reload, command or restart may request a model");
  pass("pause survives process exit/restart with the same durable session identity; zero model requests");

  await restarted.stop();

  for (const [name, options] of [
    ["legacy-contract-no-pr", {}],
    ["legacy-contract-old-pr", { oldPr: true }],
    ["legacy-contract-closed-todos", { oldPr: true, todos: [
      { content: "RUNTIME_DONE", status: "completed" },
      { content: "RUNTIME_CANCELLED", status: "cancelled" },
      { content: "RUNTIME_DROPPED", status: "abandoned" },
    ] }],
  ]) {
    const data = await fixture(name, options);
    const legacyBefore = (await entries(data.path)).filter(e => e.customType === "muse-watch.contract");
    const legacy = new Rpc(data.path);
    await legacy.command("resume");
    const state = await legacy.status();
    assert.equal(state.openTodos, 0, name);
    assert.equal(state.automaticContinuation, "premature-stop-continue");
    assert.equal((await legacy.command("continue-confirmed")).reason, "draft-not-known-empty");
    await legacy.assertQuiet(2);
    await legacy.stop();
    assert.deepEqual((await entries(data.path)).filter(e => e.customType === "muse-watch.contract"), legacyBefore);
    pass(`${name}: prose/legacy records create no work and no new contract entries`);
  }
  // Actual cancellable lifecycle hooks, not fabricated session contexts/events.
  const vetoPath = join(root, "replacement-veto.mjs");
  await writeFile(vetoPath, `export default pi => {
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
  };\n`);
  const cancelledData = await fixture("cancelled-replacement", { todos: [{ content: "RUNTIME_STILL_OPEN", status: "pending" }] });
  const cancelled = new Rpc(cancelledData.path, [vetoPath]);
  await cancelled.command("resume");
  const forkEntry = (await entries(cancelledData.path)).find(e => e.type === "message" && e.message.role === "user");
  for (const [action, parameters] of [
    ["switch_session", { sessionPath: open.path }],
    ["fork", { entryId: forkEntry.id }],
  ]) {
    assert.equal((await cancelled.request(action, parameters)).cancelled, true);
    assert.equal((await cancelled.request("get_state")).sessionId, cancelledData.sessionId);
    const status = await cancelled.status();
    assert.equal(status.sessionId, cancelledData.sessionId);
    assert.equal(status.openTodos, 1);
    assert.equal(status.paused, false);
    assert.equal((await cancelled.command("continue-confirmed")).reason, "draft-not-known-empty");
  }
  await cancelled.assertQuiet(2);
  await cancelled.stop();
  pass("real cancelled switch/fork leave the unchanged session watchdog command alive");

  // A distinct file bypasses normal path deduplication and makes the loader's
  // suffixed command aliases observable, as with two installed extension copies.
  const duplicatePath = join(root, "duplicate-watch.mjs");
  await writeFile(duplicatePath, candidateSource);
  const duplicate = new Rpc(cancelledData.path, [duplicatePath]);
  const aliases = (await duplicate.request("get_commands")).commands.filter(c => /^muse-watch(?::\d+)?$/.test(c.name));
  assert.equal(aliases.length, 2, "Both real loader aliases must be present");
  for (const alias of aliases) {
    assert.equal((await duplicate.command("pause", alias.name)).paused, true);
    assert.equal((await duplicate.command("resume", alias.name)).paused, false);
    const status = await duplicate.status(alias.name);
    assert.equal(status.sessionId, cancelledData.sessionId);
    assert.equal(status.openTodos, 1);
    assert.equal((await duplicate.command("continue-confirmed", alias.name)).reason, "draft-not-known-empty");
  }
  await duplicate.assertQuiet(2);
  await duplicate.stop();
  pass("duplicate real-loader command aliases both route to the live session owner");

  await exerciseTui();
  assert.equal(await readFile(candidate, "utf8"), candidateSource, "Candidate changed during verification; rerun against final code");
  assert.equal(requests.length, 1, "Only the explicitly confirmed TUI continuation is allowed");
  assert.equal(expectedRequest, undefined);
  assert.equal(serverError, undefined);
  console.log("PASS zero unintended provider requests, agent turns, continuation claims, queued messages or sends");
  console.log("COVERAGE LIMIT: image/clipboard attachment editing and concurrent human typing races are not exercised; RPC unknown-draft refusal and actual empty-editor TUI continuation are covered.");
  console.log(`Candidate SHA256: ${candidateHash}`);
  console.log("Runtime smoke passed (1 explicitly confirmed TUI continuation to local HTTP; 0 external model APIs).");
} catch (error) {
  console.error(`FAIL runtime smoke: ${error.stack}`);
  for (const client of clients) console.error(`Child stderr:\n${client.stderr}\nRecent events:\n${client.log.slice(-12).map(e => JSON.stringify(e)).join("\n")}`);
  process.exitCode = 1;
} finally {
  await Promise.all([...clients].map(async client => {
    client.stopping = true;
    if (client.exit) return;
    // Let the TUI tear down its engine before script closes the PTY. Killing
    // script first can orphan the engine's new process group and race cleanup.
    let timeout;
    const stopped = new Promise((resolveStopped, reject) => {
      timeout = setTimeout(() => reject(new Error("Child did not shut down during cleanup")), timeoutMs);
      client.closed.then(resolveStopped, reject);
    });
    if (client.isTui) client.child.stdin.write("/quit\r");
    else client.child.stdin.end();
    try { await stopped; }
    catch (error) {
      console.error(`Cleanup failure: ${error.message}`);
      process.exitCode = 1;
      if (client.child.pid) {
        try { process.kill(-client.child.pid, "SIGKILL"); }
        catch (killError) { if (killError.code !== "ESRCH") throw killError; }
      }
      await client.closed;
    } finally { clearTimeout(timeout); }
  }));
  server.closeAllConnections();
  await Promise.all([
    new Promise(resolveClose => server.close(resolveClose)),
    new Promise(resolveClose => observerServer.close(resolveClose)),
  ]);
  await rm(root, { recursive: true, force: true });
}
