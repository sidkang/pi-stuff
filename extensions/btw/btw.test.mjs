import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import * as tui from "@earendil-works/pi-tui";
import { createMockContext, createMockPi } from "../../tests/extension-harness.mjs";

const compiled = transformSync(readFileSync(new URL("./btw.ts", import.meta.url), "utf8"), {
  loader: "ts", format: "cjs",
}).code;

function setup(rows = 40, seed = []) {
  const harness = createMockPi();
  let listener;
  let finishPrompt;
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  const session = {
    state: { messages: [] },
    agent: { state: { messages: [] } },
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    async prompt() {
      promptStarted();
      await new Promise((resolve) => { finishPrompt = resolve; });
    },
    async abort() { finishPrompt?.(); },
    dispose() {},
  };
  let sessionOptions;
  const sdk = {
    buildSessionContext: () => ({ messages: seed }),
    createExtensionRuntime: () => ({}),
    createAgentSession: async (options) => {
      sessionOptions = options;
      return { session };
    },
    getMarkdownTheme: () => ({}),
    SessionManager: { inMemory: (cwd) => ({
      cwd, messages: [], appendMessage(message) { this.messages.push(message); },
    }) },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name === "@earendil-works/pi-coding-agent") return sdk;
    if (name === "@earendil-works/pi-tui") return tui;
    throw new Error(`Unexpected import: ${name}`);
  }, module, module.exports);
  module.exports.default(harness.pi);
  let overlay;
  let options;
  let doneCount = 0;
  let hideCount = 0;
  const terminal = { rows };
  const ctx = createMockContext({
    model: { provider: "test", id: "test", api: "test" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
    ui: {
      custom: async (factory, config) => {
        options = config;
        const handle = {
          focus() {}, isFocused: () => true, setHidden() {},
          hide() { hideCount++; },
        };
        overlay = await factory({ terminal, requestRender() {} }, ctx.ui.theme,
          { matches: (data, action) => data === "\x1b" && action === "tui.select.cancel" },
          () => { doneCount++; });
        config.onHandle(handle);
        await new Promise(() => {});
      },
    },
  });
  return {
    ...harness, ctx, terminal, session, started,
    command: (question) => harness.commands.get("btw").handler(question, ctx),
    get overlay() { return overlay; },
    get options() { return options; },
    get sessionOptions() { return sessionOptions; },
    get doneCount() { return doneCount; },
    get hideCount() { return hideCount; },
    emit(event) { listener(event); },
    finish() {
      session.state.messages.push({ role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop" });
      finishPrompt();
    },
    async cleanup() {
      for (const handler of harness.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

// These tests use real Pi Input and terminal-width utilities, without model/network calls.
test("seeds the authoritative session manager and supplies Pi 1.4 resource metadata", async () => {
  const seed = [{ role: "user", content: [{ type: "text", text: "Main context" }], timestamp: 1 }];
  const h = setup(40, seed);
  try {
    const running = h.command("Question");
    await h.started;
    const options = h.sessionOptions;
    assert.deepEqual(options.sessionManager.messages, seed);
    assert.equal(options.cwd, h.ctx.cwd);
    assert.equal(options.sessionManager.cwd, h.ctx.cwd);
    assert.equal(options.resourceLoader.getSystemPromptSource(), undefined);
    assert.deepEqual(options.resourceLoader.getAppendSystemPromptSources(), []);
    h.finish();
    await running;
  } finally { await h.cleanup(); }
});

test("fits the allocated width and terminal height, retaining input and IME cursor", async () => {
  const h = setup();
  try {
    await h.command("");
    for (const rows of [11, 16, 24, 40, 80]) {
      h.terminal.rows = rows;
      for (const width of [8, 20, 72, 120]) {
        const lines = h.overlay.render(width);
        assert.ok(lines.length <= rows - 1, `${rows} rows: ${lines.length} rendered`);
        assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `${width} columns`);
        assert.match(lines.at(-1), /└.*┘/);
        assert.ok(lines.some((line) => line.includes(tui.CURSOR_MARKER)), "focused input positions IME");
      }
    }
    assert.equal(h.options.overlayOptions.visible(80, 10), false);
    assert.equal(h.options.overlayOptions.visible(80, 11), true);
  } finally { await h.cleanup(); }
});

test("closes custom UI through done exactly once, without hiding its overlay handle", async () => {
  const h = setup();
  try {
    await h.command("");
    h.overlay.handleInput("\x1b");
    h.overlay.handleInput("\x1b");
    assert.equal(h.doneCount, 1);
    assert.equal(h.hideCount, 0);
  } finally { await h.cleanup(); }
});

test("tool results do not overwrite status; thinking after tool turns is not finalizing", async () => {
  const h = setup();
  try {
    const running = h.command("Question");
    await h.started;
    const render = () => h.overlay.render(100).join("\n");
    h.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "echo ok" } });
    h.emit({ type: "message_end", message: { role: "toolResult", content: [] } });
    assert.match(render(), /Running tool: bash/);
    h.emit({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } });
    assert.match(render(), /Thinking side response/);
    h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    assert.match(render(), /Thinking side response/);
    h.finish();
    await running;
    assert.match(render(), /Ready for the next side question/);
    assert.equal(h.entries.filter(([type]) => type === "btw-thread-entry").length, 1);
  } finally { await h.cleanup(); }
});

test("parallel calls of the same tool finish by call ID rather than arrival order", async () => {
  const h = setup();
  try {
    const running = h.command("Question");
    await h.started;
    for (const id of ["first", "second"]) h.emit({
      type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id },
    });
    h.emit({ type: "tool_execution_end", toolCallId: "second", toolName: "bash", isError: true });
    const lines = h.overlay.render(100).join("\n");
    assert.match(lines, /⚙ bash first/);
    assert.match(lines, /✗ bash second/);
    h.finish();
    await running;
  } finally { await h.cleanup(); }
});

test("reopening a busy chat preserves the request and rejected submits preserve the draft", async () => {
  const h = setup();
  try {
    const running = h.command("Question");
    await h.started;
    h.overlay.setDraft("next question");
    h.overlay.handleInput("\n");
    assert.equal(h.overlay.getDraft(), "next question");
    await h.command("");
    assert.match(h.overlay.render(100).join("\n"), /You: Question/);
    h.finish();
    await running;
    assert.equal(h.entries.filter(([type]) => type === "btw-thread-entry").length, 1);
  } finally { await h.cleanup(); }
});
