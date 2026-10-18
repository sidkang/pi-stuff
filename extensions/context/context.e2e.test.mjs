import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { findHost } from "./test-host.mjs";

test("context evidence rejects a physical FIFO replacement without blocking finalized read", { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "context-fifo-e2e-"));
  chmodSync(root, 0o700);
  const observations = [];
  let output = "";
  let deadline;
  let timedOut = false;
  const child = fork(fileURLToPath(new URL("./context-fifo-child.mjs", import.meta.url)), [root],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const killAtDeadline = () => {
    timedOut = true;
    child.kill("SIGKILL"); // Never open a FIFO writer to rescue a broken implementation.
  };
  deadline = setTimeout(killAtDeadline, 30_000);
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("message", observation => {
    observations.push(observation);
    if (observation.stage === "fifo-replaced") {
      clearTimeout(deadline);
      deadline = setTimeout(killAtDeadline, 10_000);
    }
  });
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    console.log(JSON.stringify({ fifoChildExit: exit, timedOut, observations, output }));
    assert.equal(timedOut, false, "real prompt must finish after FIFO replacement; child was killed at deadline");
    assert.deepEqual(exit, { code: 0, signal: null }, output);
    assert.deepEqual(observations.map(item => item.stage), ["fifo-replaced", "verified"]);
    assert.equal(observations[1].retainedText, observations[0].retainedText);
    assert.equal(observations[1].markerCount, 0);
    assert.ok(["0.99.1", "0.99.2"].includes(observations[1].version));
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("close", resolve));
    }
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, "parent removes workspace and FIFO even when the child hangs");
    console.log("FIFO child/workspace cleanup verified.");
  }
});

test("context host overrides fail closed without default discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "context-host-discovery-"));
  const previous = process.env.PI_CONTEXT_TEST_HOST;
  try {
    for (const value of ["", "   ", join(root, "missing"), root]) {
      process.env.PI_CONTEXT_TEST_HOST = value;
      assert.throws(findHost, /Actual Pi 0\.99\.1 or 0\.99\.2 required/);
    }
    process.env.PI_CONTEXT_TEST_HOST = root;
    mkdirSync(join(root, "dist"));
    // Invalid metadata fixtures are never imported as SDKs.
    writeFileSync(join(root, "dist/index.js"), "");
    writeFileSync(join(root, "dist/index.d.ts"), "");
    for (const metadata of ["{", JSON.stringify({ name: "wrong-package", version: "0.99.2" }),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.3" }),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.0" })]) {
      writeFileSync(join(root, "package.json"), metadata);
      assert.throws(findHost, /Actual Pi 0\.99\.1 or 0\.99\.2 required/);
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.2" }));
    rmSync(join(root, "dist/index.js"));
    assert.throws(findHost, /Actual Pi 0\.99\.1 or 0\.99\.2 required/);
  } finally {
    if (previous === undefined) delete process.env.PI_CONTEXT_TEST_HOST; else process.env.PI_CONTEXT_TEST_HOST = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// The only fixture is the remote provider. Pi itself, its read tool, permissions,
// transcript, resource loader, QuickJS and native codemode conversions are real.
test("actual Pi 0.99.1/0.99.2 context/native-codemode session pipeline", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "context-pi-e2e-"));
  chmodSync(root, 0o700);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(agentDir, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const previousPackageDir = process.env.PI_PACKAGE_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
    if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = previousPackageDir;
    rmSync(root, { recursive: true, force: true });
  });
  const host = findHost();
  const version = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version;
  assert.ok(["0.99.1", "0.99.2"].includes(version));
  console.log(`Actual Pi host ${version}: ${host}`);
  // SDK config reads package metadata/assets from this env, which can be inherited from a different Pi.
  process.env.PI_PACKAGE_DIR = host;
  const pi = await import(pathToFileURL(join(host, "dist/index.js")).href);
  assert.equal(pi.VERSION, version, "loaded SDK matches the selected real package version");
  const { createRequire } = await import("node:module");
  const Type = await import(pathToFileURL(createRequire(join(host, "package.json")).resolve("typebox")).href);
  const pending = [];
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const next = pending.shift();
    if (!next) { res.writeHead(500); res.end("Unexpected model request"); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    event({ role: "assistant", ...next });
    event({}, next.tool_calls ? "tool_calls" : "stop", { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "context-fixture": {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture-not-a-secret",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
      contextWindow: 200000, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
  } } }));
  const skills = new Map();
  const regressionSkills = new Set(["direct-prefix", "direct-message-prefix", "direct-notice", "direct-empty", "direct-unrelated", "direct-failed", "nested-error-caught"]);
  const sourceProofSkills = new Set(["direct-overlong", "direct-early-redacted", "direct-offset", "literal-full", "literal-partial"]);
  for (const name of ["direct", "full", "discarded", "partial", "limited", "failed", "blocked", "concurrent-emitted", "concurrent-discarded", "redacted", "late-redacted", "expanded", ...regressionSkills, ...sourceProofSkills]) {
    const dir = join(cwd, name);
    mkdirSync(dir);
    const file = join(dir, "SKILL.md");
    const text = `---\nname: ${name}\ndescription: fixture ${name}\n---\n\n# ${name}\nUNIQUE-${name}-COMPLETE\nLast line for ${name}.\n`;
    writeFileSync(file, text);
    skills.set(name, { file, text });
  }
  const overlong = skills.get("direct-overlong");
  const overlongOffset = overlong.text.split("\n").length;
  overlong.text += `${"X".repeat(51201)}\nAFTER-OVERLONG-VALID\n`;
  writeFileSync(overlong.file, overlong.text);
  const literalNotice = "[3 more lines in file. Use offset=2 to continue.]";
  for (const name of ["literal-full", "literal-partial"]) {
    const skill = skills.get(name);
    skill.text += `\n${literalNotice}${name === "literal-partial" ? "\nRemaining real file text\n" : ""}`;
    writeFileSync(skill.file, skill.text);
  }
  const earlyRedactorPath = join(root, "early-redactor.ts");
  writeFileSync(earlyRedactorPath, `export default function (api) {
    api.on("tool_result", (event) => {
      if (event.toolName === "read" && event.input.path === ${JSON.stringify(skills.get("direct-early-redacted").file)}) {
        return { content: [{ type: "text", text: "[skill read redacted]" }] };
      }
    });
  }`);
  writeFileSync(join(cwd, "AGENTS.md"), "Fixture project instructions.\n");
  let session;
  let serial = 0;
  const sessions = [];
  const permissionEvents = [];
  const extensionErrors = [];
  const rewrittenDirectReads = new Map();
  const finalizedNestedEnds = [];
  const executing = new Set();
  let maxConcurrent = 0;
  try {
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
    const model = modelRuntime.getModel("context-fixture", "fixture");
    assert.ok(model, "fixture model loaded by real model runtime");
    const settingsManager = pi.SettingsManager.inMemory({ defaultTools: ["read", "codemode", "ask"],
      compaction: { enabled: false }, retry: { enabled: false } });
    async function open(mode = "on", manager = pi.SessionManager.inMemory(cwd), earlyRedactor = false) {
      const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [...(earlyRedactor ? [earlyRedactorPath] : []), fileURLToPath(new URL("./context.ts", import.meta.url))],
        additionalSkillPaths: [...skills.values()].map((skill) => skill.file),
        extensionFactories: [pi.createCodemodeExtension({ mode }), (api) => {
          for (const [name, exposure] of [["ask", "model-only"], ["lazy", "codemode"], ["later", "deferred"], ["withdrawn", "hidden"]]) {
            api.registerTool({ name, label: name, description: "fixture tool", exposure,
              namespace: { name: "fixture-ns" }, parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }) });
          }
          api.on("tool_call", (event) => {
            permissionEvents.push({ name: event.toolName, path: event.input.path, parent: event.parentToolCallId, id: event.toolCallId });
            if (event.toolName === "read" && event.input.path === skills.get("blocked").file) {
              return { block: true, reason: "fixture permission denied" };
            }
          });
          // Registered after context: finalized output must honor later redaction.
          api.on("tool_result", (event) => {
            if (event.toolName === "read") {
              if (event.parentToolCallId && event.input.path === skills.get("nested-error-caught").file) {
                return { isError: true };
              }
              if (!event.parentToolCallId) {
                const original = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
                for (const name of ["direct-prefix", "direct-notice", "direct-empty", "direct-unrelated", "direct-failed"]) {
                  if (event.input.path !== skills.get(name).file) continue;
                  const retained = name === "direct-notice"
                    ? original.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "")
                    : name === "direct-empty" ? "" : name === "direct-unrelated" ? "[skill read redacted]" : original.slice(0, 80);
                  rewrittenDirectReads.set(name, { original, retained });
                  return { content: [{ type: "text", text: retained }], isError: name === "direct-failed" };
                }
              }
            }
            if (event.toolName === "codemode" && event.input.code?.includes("REDACT")) {
              return { content: [{ type: "text", text: "redacted" }] };
            }
          });
          api.on("message_end", (event) => {
            if (event.message.role === "toolResult" && event.message.toolName === "read" && event.message.content.some((part) =>
              part.type === "text" && part.text.includes("UNIQUE-direct-message-prefix-COMPLETE"))) {
              const retained = skills.get("direct-message-prefix").text.slice(0, 80);
              return { message: { ...event.message, content: [{ type: "text", text: retained }] } };
            }
            if (event.message.role === "toolResult" && event.message.content.some((part) =>
              part.type === "text" && part.text.includes("UNIQUE-late-redacted-COMPLETE"))) {
              return { message: { ...event.message, content: [{ type: "text", text: "late message redaction" }] } };
            }
          });
        }],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      if (earlyRedactor) {
        const loaded = resourceLoader.getExtensions().extensions;
        const earlyIndex = loaded.findIndex((extension) => extension.path.endsWith("/early-redactor.ts"));
        const contextIndex = loaded.findIndex((extension) => extension.path.endsWith("/context.ts"));
        assert.ok(earlyIndex >= 0 && contextIndex > earlyIndex, "the real loader registers the redactor BEFORE context");
      }
      assert.equal(resourceLoader.getSkills().skills.length, skills.size);
      const created = await pi.createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader,
        settingsManager, sessionManager: manager, thinkingLevel: "off" });
      sessions.push(created.session);
      created.session.subscribe((event) => {
        if (event.type === "extension_error") extensionErrors.push(event);
        if (event.parentToolCallId && event.type === "tool_execution_end" && event.toolName === "read") {
          finalizedNestedEnds.push({ id: event.toolCallId, parent: event.parentToolCallId, isError: event.isError });
        }
        if (!event.parentToolCallId && event.type === "tool_execution_start" && event.toolName === "codemode") {
          executing.add(event.toolCallId);
          maxConcurrent = Math.max(maxConcurrent, executing.size);
        }
        if (!event.parentToolCallId && event.type === "tool_execution_end") executing.delete(event.toolCallId);
      });
      await created.session.bindExtensions({ mode: "print" });
      return created.session;
    }
    const toolCall = (name, args) => ({ index: 0, id: `fixture-${++serial}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    async function run(calls, target = session) {
      if (calls.length) pending.push({ tool_calls: calls.map((call, index) => ({ ...call, index })) });
      pending.push({ content: "Fixture done." });
      await target.prompt(`Fixture turn ${serial}`);
      assert.equal(target.messages.at(-1).role, "assistant");
      assert.equal(target.messages.at(-1).stopReason, "stop", target.messages.at(-1).errorMessage);
      assert.equal(pending.length, 0);
    }
    const read = (name) => `await tools.read({path:${JSON.stringify(skills.get(name).file)}})`;
    const code = (script) => toolCall("codemode", { code: script });
    const markers = (target = session) => target.sessionManager.buildContextEntries()
      .filter((entry) => entry.customType === "context:skill_loaded").map((entry) => entry.data.name);
    async function report(target = session) {
      const before = requests.length;
      await target.prompt("/context");
      assert.equal(requests.length, before, "/context must not call the model");
      const entry = target.sessionManager.getEntries().at(-1);
      assert.equal(entry.customType, "context:report");
      assert.ok(!target.sessionManager.buildSessionContext().messages.some((message) => message.customType === "context:report"));
      return entry.data;
    }

    session = await open();
    const initial = await report();
    assert.match(initial.content, /Window: ~0 \/ 200,000/);
    assert.ok(initial.toolInventory.every((row) => row.declared === null));
    const branchPoint = session.sessionManager.getLeafId();
    await run([toolCall("read", { path: skills.get("direct").file })]);
    assert.deepEqual(markers(), ["direct"]);
    await run([code(`text(${read("full")});`)]);
    assert.deepEqual(markers(), ["direct", "full"]);
    await run([code(`${read("discarded")}; text("discarded");`)]);
    await run([code(`const value = ${read("partial")}; text(value.slice(0, 20));`)]);
    await run([code(`text(await tools.read({path:${JSON.stringify(skills.get("limited").file)},limit:2}));`)]);
    await run([code(`text(${read("failed")}); throw new Error("fixture failure");`)]);
    await run([code(`text(${read("blocked")});`)]);
    await run([code(`// REDACT\ntext(${read("redacted")});`)]);
    await run([code(`text(${read("late-redacted")});`)]);
    await run([
      code(`text(${read("concurrent-emitted")});`),
      code(`${read("concurrent-discarded")}; text("no skill output");`),
    ]);
    assert.ok(maxConcurrent >= 2, "native codemode siblings actually overlapped in the real tool pipeline");
    assert.deepEqual(markers(), ["direct", "full", "concurrent-emitted"]);
    for (const [name, skill] of skills) {
      if (name !== "expanded" && !regressionSkills.has(name) && !sourceProofSkills.has(name)) assert.ok(permissionEvents.some((event) => event.path === skill.file), `real read pipeline exercised ${name}`);
    }
    const toolResults = session.sessionManager.getEntries().filter((entry) => entry.message?.role === "toolResult");
    assert.ok(toolResults.some((entry) => entry.message.nestedCalls?.calls?.length || entry.message.nestedCalls?.length), "real nested calls persisted");
    assert.ok(permissionEvents.some((event) => event.name === "read" && event.parent), "nested permission pipeline used");
    assert.ok(!session.sessionManager.getEntries().some((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId.includes("/")), "nested results have no standalone transcript entry");
    await run([code('text(await tools.lazy({})); text(await tools.later({}));')]);
    assert.ok(permissionEvents.some((event) => event.name === "lazy" && event.parent), "inactive codemode exposure is actually callable");
    assert.ok(permissionEvents.some((event) => event.name === "later" && event.parent), "inactive deferred exposure is actually callable");
    const on = await report();
    assert.equal(session.getContextUsage().tokens, 1010);
    assert.match(on.content, /Window: ~1,010 \/ 200,000/);
    assert.match(on.content, /AGENTS: \.\/AGENTS\.md/);
    const declarationEstimate = requests.at(-1).tools.reduce((sum, tool) => sum + Math.ceil(JSON.stringify(tool).length / 4), 0);
    assert.match(on.content, new RegExp(`Tools: ~${declarationEstimate.toLocaleString()} tok`), "estimate uses final rewritten declarations");
    const onRows = new Map(on.toolInventory.map((row) => [row.name, row]));
    assert.equal(onRows.get("read").declared, true);
    assert.equal(onRows.get("codemode").declared, true);
    assert.equal(onRows.get("codemode").callable, false);
    assert.equal(onRows.get("ask").declared, true);
    assert.equal(onRows.get("ask").callable, false);
    for (const name of ["lazy", "later"]) {
      assert.equal(onRows.get(name).active, false);
      assert.equal(onRows.get(name).callable, true);
      assert.equal(onRows.get(name).declared, false);
      assert.equal(onRows.get(name).namespace, "fixture-ns");
    }
    assert.equal(onRows.get("withdrawn").callable, false);
    const usage = session.sessionManager.getEntries().reduce((sum, entry) => sum +
      (entry.message?.usage?.totalTokens ?? 0), 0);
    assert.match(on.content, new RegExp(`Session: ${usage.toLocaleString()} tokens`));
    const savedLeaf = session.sessionManager.getLeafId();
    await session.navigateTree(branchPoint, { summarize: false });
    assert.deepEqual(markers(), []);
    const branchReport = await report();
    assert.match(branchReport.content, /Loaded skills: \(none\)/);
    assert.match(branchReport.content, new RegExp(`Session: ${usage.toLocaleString()} tokens`), "abandoned branches still count billed usage");
    await session.navigateTree(savedLeaf, { summarize: false });
    assert.deepEqual(markers(), ["direct", "full", "concurrent-emitted"]);

    // Reconstruct through a fresh real extension runtime from the canonical entry tree.
    const reconstructedManager = pi.SessionManager.inMemory(cwd, undefined,
      [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()]);
    reconstructedManager.branch(savedLeaf);
    const reconstructed = await open("on", reconstructedManager);
    assert.deepEqual(markers(reconstructed), ["direct", "full", "concurrent-emitted"]);
    assert.match((await report(reconstructed)).content, /Loaded skills: direct, full, concurrent-emitted/);
    pending.push({ content: "Expanded fixture done." });
    await reconstructed.prompt("/skill:expanded");
    assert.ok(markers(reconstructed).includes("expanded"));
    const lastAssistant = reconstructed.sessionManager.getEntries().findLast((entry) => entry.message?.role === "assistant");
    reconstructedManager.appendCompaction("fixture compacted history", lastAssistant.id, 1000);
    assert.deepEqual(markers(reconstructed), []);
    assert.match((await report(reconstructed)).content, /Loaded skills: \(none\)/);

    const only = await open("only");
    await run([code(`text(${read("full")});`)], only);
    const onlyReport = await report(only);
    const onlyRows = new Map(onlyReport.toolInventory.map((row) => [row.name, row]));
    assert.equal(onlyRows.get("read").active, true);
    assert.equal(onlyRows.get("read").declared, false);
    assert.equal(onlyRows.get("read").callable, true);
    assert.equal(onlyRows.get("ask").declared, true, "model-only tools stay declared in native only mode");
    assert.equal(onlyRows.get("codemode").declared, true);
    assert.deepEqual(markers(only), ["full"]);
    const payload = requests.at(-1);
    const actualDeclared = payload.tools.map((tool) => tool.function.name);
    assert.ok(!actualDeclared.includes("read"));
    assert.ok(payload.tools.find((tool) => tool.function.name === "codemode").function.description.includes("tools.read"), "native rewritten declaration observed");
    only.setActiveToolsByName(["read", "ask"]);
    assert.ok((await report(only)).toolInventory.every((row) => row.declared === null), "changed loadout is not stale evidence");
    await run([], only);
    const inactiveRows = new Map((await report(only)).toolInventory.map((row) => [row.name, row]));
    assert.equal(inactiveRows.get("codemode").active, false);
    assert.equal(inactiveRows.get("codemode").declared, false);
    assert.equal(inactiveRows.get("codemode").callable, false);
    assert.equal(inactiveRows.get("read").declared, true, "inactive codemode no longer hides direct declarations");

    const regressions = await open();
    for (const name of regressionSkills) {
      if (name === "nested-error-caught") continue;
      await run([toolCall("read", { path: skills.get(name).file, ...(name === "direct-notice" ? { limit: 6 } : {}) })], regressions);
      const retainedResult = regressions.sessionManager.getEntries().findLast((entry) => entry.message?.role === "toolResult").message;
      const retainedText = retainedResult.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const marker = regressions.sessionManager.buildContextEntries().find((entry) => entry.customType === "context:skill_loaded" && entry.data.name === name);
      if (["direct-prefix", "direct-message-prefix", "direct-notice"].includes(name)) {
        const expected = name === "direct-notice" ? skills.get(name).text.split("\n").slice(0, 6).join("\n") : skills.get(name).text.slice(0, 80);
        assert.equal(retainedResult.isError, false);
        assert.equal(retainedText, expected, `successful finalized ${name} text is retained`);
        assert.ok(marker, `successful finalized ${name} marks a direct skill load`);
        assert.equal(marker.data.tokens, Math.ceil(expected.length / 4), "only finalized retained text tokens count");
        if (name === "direct-notice") assert.match(rewrittenDirectReads.get(name).original, /\[\d+ more lines in file\. Use offset=7 to continue\.\]$/);
      } else {
        assert.equal(marker, undefined, `failed/empty/wholly redacted ${name} stays unmarked`);
        if (name === "direct-failed") assert.equal(retainedResult.isError, true);
      }
    }
    const catchingCall = code(`try { ${read("nested-error-caught")}; } catch (error) { text(error.message); }`);
    await run([catchingCall], regressions);
    const catchingResult = regressions.sessionManager.getEntries().findLast((entry) => entry.message?.role === "toolResult").message;
    assert.equal(catchingResult.toolCallId, catchingCall.id);
    assert.equal(catchingResult.isError, false, "native codemode parent catches the finalized nested failure and succeeds");
    assert.ok(catchingResult.content.some((part) => part.type === "text" && part.text.includes(skills.get("nested-error-caught").text)), "catching parent actually emits the complete failed skill read text");
    const failedNested = catchingResult.nestedCalls.calls.find((call) => call.arguments?.path === skills.get("nested-error-caught").file);
    assert.equal(failedNested.status, "error", "canonical nested record stores finalized failure");
    assert.ok(finalizedNestedEnds.some((event) => event.id === failedNested.id && event.parent === catchingCall.id && event.isError), "real finalized tool_execution_end reports this nested read's own failure");
    assert.deepEqual(markers(regressions), ["direct-prefix", "direct-message-prefix", "direct-notice"]);
    const regressionReport = await report(regressions);
    assert.match(regressionReport.content, /Loaded skills: direct-prefix, direct-message-prefix, direct-notice/);

    const sourceProof = await open("on", pi.SessionManager.inMemory(cwd), true);
    const lastToolResult = () => sourceProof.sessionManager.getEntries().findLast((entry) => entry.message?.role === "toolResult").message;
    const textOf = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const longReadArgs = { path: overlong.file, offset: overlongOffset, limit: 1 };
    await run([toolCall("read", longReadArgs)], sourceProof);
    assert.equal(lastToolResult().isError, false, "native overlong selected-line diagnostic is a successful read result");
    assert.equal(lastToolResult().details.truncation.firstLineExceedsLimit, true);
    assert.equal(lastToolResult().details.truncation.outputBytes, 0, "the native diagnostic carries zero requested file bytes");
    assert.match(textOf(lastToolResult()), /exceeds 50\.0KB limit\. Use bash:.*head -c 51200\]/);
    assert.deepEqual(markers(sourceProof), [], "no file text means no direct skill marker");
    await run([code(`text(await tools.read(${JSON.stringify(longReadArgs)}));`)], sourceProof);
    assert.match(textOf(lastToolResult()), /Use bash:/);
    assert.deepEqual(markers(sourceProof), [], "emitting the same native diagnostic through codemode is not a full load");
    await run([toolCall("read", { path: skills.get("direct-early-redacted").file })], sourceProof);
    assert.equal(lastToolResult().isError, false);
    assert.equal(textOf(lastToolResult()), "[skill read redacted]");
    assert.deepEqual(markers(sourceProof), [], "successful unrelated output from a BEFORE-context redactor is not skill evidence");
    await run([code(`text(${read("direct-early-redacted")});`)], sourceProof);
    assert.ok(textOf(lastToolResult()).includes("[skill read redacted]"));
    assert.deepEqual(markers(sourceProof), [], "early-redacted nested text remains unmarked");
    for (const [name, args, expected] of [
      ["direct-overlong", { path: overlong.file, offset: overlongOffset + 1, limit: 1 }, "AFTER-OVERLONG-VALID"],
      ["direct-offset", { path: skills.get("direct-offset").file, offset: 6, limit: 2 }, skills.get("direct-offset").text.split("\n").slice(5, 7).join("\n")],
    ]) {
      await run([toolCall("read", args)], sourceProof);
      assert.equal(lastToolResult().isError, false);
      assert.ok(textOf(lastToolResult()).startsWith(expected));
      assert.match(textOf(lastToolResult()), /\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/);
      const marker = sourceProof.sessionManager.buildContextEntries().find((entry) => entry.customType === "context:skill_loaded" && entry.data.name === name);
      assert.ok(marker, `actual requested offset/limit text for ${name} counts`);
      assert.equal(marker.data.tokens, Math.ceil(expected.length / 4), "native continuation notices are not counted as skill content");
    }
    assert.deepEqual(markers(sourceProof), ["direct-overlong", "direct-offset"]);
    assert.match((await report(sourceProof)).content, /Loaded skills: direct-overlong, direct-offset/);

    const literalDirect = await open();
    const literalNested = await open();
    const literalFull = skills.get("literal-full");
    await run([toolCall("read", { path: literalFull.file })], literalDirect);
    const directLiteralResult = literalDirect.sessionManager.getEntries().findLast((entry) => entry.message?.role === "toolResult").message;
    assert.equal(directLiteralResult.isError, false);
    assert.equal(textOf(directLiteralResult), literalFull.text, "native full read has only literal file text, no appended notice");
    await run([code(`text(${read("literal-full")});`)], literalNested);
    const nestedLiteralResult = literalNested.sessionManager.getEntries().findLast((entry) => entry.message?.role === "toolResult").message;
    assert.equal(nestedLiteralResult.isError, false);
    assert.ok(textOf(nestedLiteralResult).includes(literalFull.text));
    assert.ok(permissionEvents.some((event) => event.path === literalFull.file && event.parent), "literal file really read through native codemode/permissions");
    const literalMarker = (target, name) => target.sessionManager.buildContextEntries()
      .find((entry) => entry.customType === "context:skill_loaded" && entry.data.name === name);
    const fullTokens = Math.ceil(literalFull.text.length / 4);
    const directTokens = literalMarker(literalDirect, "literal-full")?.data.tokens;
    const nestedTokens = literalMarker(literalNested, "literal-full")?.data.tokens;
    console.log(JSON.stringify({ literalSuffix: { version, fullText: literalFull.text, fullTokens, directTokens, nestedTokens } }));
    assert.equal(nestedTokens, fullTokens, "nested load retains literal final paragraph tokens");
    assert.equal(directTokens, fullTokens, "direct load must count the literal final paragraph as verified file text");

    const literalPartial = skills.get("literal-partial");
    const literalLimit = literalPartial.text.split("\n").length - 2;
    const literalRequested = literalPartial.text.split("\n").slice(0, literalLimit).join("\n");
    await run([toolCall("read", { path: literalPartial.file, limit: literalLimit })], literalDirect);
    const partialLiteralResult = literalDirect.sessionManager.getEntries().findLast((entry) => entry.message?.role === "toolResult").message;
    assert.equal(partialLiteralResult.isError, false);
    assert.ok(literalRequested.endsWith(literalNotice));
    const actualNotice = `\n\n[2 more lines in file. Use offset=${literalLimit + 1} to continue.]`;
    assert.equal(textOf(partialLiteralResult), literalRequested + actualNotice, "native partial read contains BOTH literal paragraph and actual appended continuation");
    const partialTokens = literalMarker(literalDirect, "literal-partial")?.data.tokens;
    assert.equal(partialTokens, Math.ceil(literalRequested.length / 4), "strip only the actual appended notice, not the literal source paragraph");
    console.log(JSON.stringify({ literalPartial: { version, requestedText: literalRequested, actualNotice, partialTokens } }));
    assert.deepEqual(extensionErrors, []);
    console.log(`Verified ${requests.length} local provider requests; real transcript skill, usage, branch, reconstruction, compaction and inventory assertions passed.`);
  } finally {
    for (const item of sessions) item.dispose();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
  }
});
