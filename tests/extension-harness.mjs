import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createMockFunction(implementation = undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    if (fn.impl) return fn.impl(...args);
    return undefined;
  };
  fn.calls = [];
  fn.impl = implementation;
  fn.mockImplementation = (nextImplementation) => {
    fn.impl = nextImplementation;
    return fn;
  };
  fn.mockResolvedValue = (value) => {
    fn.impl = async () => value;
    return fn;
  };
  fn.mockReturnValue = (value) => {
    fn.impl = () => value;
    return fn;
  };
  fn.reset = () => {
    fn.calls = [];
    fn.impl = implementation;
  };
  return fn;
}

export function createMockPi(options = {}) {
  const tools = new Map();
  const commands = new Map();
  const flags = new Map();
  const handlers = new Map();
  const shortcuts = new Map();
  const messageRenderers = new Map();
  const providers = new Map();
  const sentMessages = [];
  const sentUserMessages = [];
  const entries = [];
  const labels = new Map();
  const flagValues = new Map(Object.entries(options.flags ?? {}));

  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      assert.equal(typeof tool?.name, "string", "registered tool has a name");
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      assert.equal(typeof name, "string", "registered command has a name");
      commands.set(name, command);
    },
    registerFlag(name, flag) {
      flags.set(name, flag);
      if (!flagValues.has(name) && Object.hasOwn(flag, "default")) flagValues.set(name, flag.default);
    },
    registerShortcut(shortcut, definition) {
      shortcuts.set(shortcut, definition);
    },
    registerMessageRenderer(customType, renderer) {
      messageRenderers.set(customType, renderer);
    },
    registerProvider(nameOrProvider, config) {
      if (typeof nameOrProvider === "string") providers.set(nameOrProvider, config);
      else providers.set(nameOrProvider.id, nameOrProvider);
    },
    unregisterProvider(name) {
      providers.delete(name);
    },
    sendMessage(message, sendOptions) {
      sentMessages.push([message, sendOptions]);
    },
    sendUserMessage(content, sendOptions) {
      sentUserMessages.push([content, sendOptions]);
    },
    appendEntry(customType, data) {
      entries.push([customType, data]);
    },
    setSessionName: createMockFunction(),
    getSessionName: createMockFunction(() => undefined),
    setLabel(entryId, label) {
      if (label === undefined) labels.delete(entryId);
      else labels.set(entryId, label);
    },
    getActiveTools: createMockFunction(() => options.activeTools ?? []),
    getAllTools: createMockFunction(() => [...tools.values()]),
    setActiveTools: createMockFunction(),
    setModel: createMockFunction(async () => false),
    getThinkingLevel: createMockFunction(() => "off"),
    setThinkingLevel: createMockFunction(),
    getFlag(name) {
      return flagValues.get(name);
    },
    exec: createMockFunction(async () => {
      throw new Error("pi.exec was not mocked for this test");
    }),
    events: {
      on: createMockFunction(),
      emit: createMockFunction(),
    },
  };

  return {
    pi,
    tools,
    commands,
    flags,
    handlers,
    shortcuts,
    messageRenderers,
    providers,
    sentMessages,
    sentUserMessages,
    entries,
    labels,
    flagValues,
  };
}

export function createMockContext(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const sessionEntries = options.entries ?? [];
  const uiOverrides = options.ui ?? {};
  const defaultTheme = {
    fg: createMockFunction((_name, text) => text),
    bg: createMockFunction((_name, text) => text),
    bold: createMockFunction((text) => text),
  };
  const { theme: themeOverrides, ...uiRest } = uiOverrides;
  const ui = {
    notify: createMockFunction(),
    setStatus: createMockFunction(),
    setWidget: createMockFunction(),
    setTitle: createMockFunction(),
    setEditorText: createMockFunction(),
    getEditorText: createMockFunction(() => ""),
    select: createMockFunction(async () => undefined),
    confirm: createMockFunction(async () => false),
    input: createMockFunction(async () => undefined),
    editor: createMockFunction(async () => undefined),
    theme: { ...defaultTheme, ...(themeOverrides ?? {}) },
    ...uiRest,
  };

  return {
    cwd,
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui,
    signal: options.signal,
    sessionManager: {
      getEntries: createMockFunction(() => sessionEntries),
      getBranch: createMockFunction(() => sessionEntries),
      getTree: createMockFunction(() => options.tree ?? []),
      getSessionId: createMockFunction(() => options.sessionId ?? "test-session"),
      getLeafId: createMockFunction(() => options.leafId),
      getSessionDir: createMockFunction(() => options.sessionDir),
      getSessionFile: createMockFunction(() => options.sessionFile),
      getSessionFileForDisplay: createMockFunction(() => options.sessionFile),
      getHeader: createMockFunction(() => options.header),
      getLabel: createMockFunction(() => undefined),
      ...(options.sessionManager ?? {}),
    },
    modelRegistry: options.modelRegistry ?? {},
    model: options.model,
    isProjectTrusted: createMockFunction(() => true),
    isIdle: createMockFunction(() => true),
    abort: createMockFunction(),
    hasPendingMessages: createMockFunction(() => false),
    shutdown: createMockFunction(),
    getContextUsage: createMockFunction(() => undefined),
    compact: createMockFunction(),
    getSystemPrompt: createMockFunction(() => ""),
    waitForIdle: createMockFunction(async () => {}),
    newSession: createMockFunction(async () => ({ cancelled: false })),
    fork: createMockFunction(async () => ({ cancelled: false })),
    navigateTree: createMockFunction(async () => ({ cancelled: false })),
    switchSession: createMockFunction(async () => ({ cancelled: false })),
    reload: createMockFunction(async () => {}),
    sendMessage: createMockFunction(async () => {}),
    sendUserMessage: createMockFunction(async () => {}),
    ...(options.context ?? {}),
  };
}

export function withTempDir(prefix = "pi-extension-test-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
