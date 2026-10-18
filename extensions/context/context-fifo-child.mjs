// A separate OS process is required: a blocking FIFO open cannot be cancelled
// by node:test's timeout or session.abort(). Only model HTTP is scripted here.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findHost } from "./test-host.mjs";

const root = process.argv[2]; // Allocated and always removed by the parent.
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
mkdirSync(agentDir, { mode: 0o700 });
mkdirSync(cwd, { mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const host = findHost();
process.env.PI_PACKAGE_DIR = host;
const version = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version;
const pi = await import(pathToFileURL(join(host, "dist/index.js")).href);
assert.equal(pi.VERSION, version);
console.log(`FIFO regression actual Pi ${version}: ${host}`);
const file = join(cwd, "SKILL.md");
const text = "---\nname: fifo-replaced\ndescription: physical FIFO replacement\n---\n\n# Skill\nUNIQUE-FIFO-RETAINED\n";
writeFileSync(file, text);
const mutator = join(root, "fifo-mutator.ts");
writeFileSync(mutator, `
  import assert from "node:assert/strict";
  import { unlinkSync, lstatSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  export default function(api) {
    api.on("tool_result", (event) => {
      if (event.toolName !== "read" || event.input.path !== ${JSON.stringify(file)}) return;
      assert.equal(event.isError, false);
      assert.equal(event.content.filter(part => part.type === "text").map(part => part.text).join("\\n"), ${JSON.stringify(text)});
      unlinkSync(${JSON.stringify(file)});
      execFileSync("mkfifo", ["-m", "600", ${JSON.stringify(file)}]);
      assert.ok(lstatSync(${JSON.stringify(file)}).isFIFO());
      // No writer is ever opened. Leave the genuine successful read unchanged.
      process.send({ stage: "fifo-replaced", retainedText: ${JSON.stringify(text)} });
    });
  }
`);
const pending = [];
const requests = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  const next = pending.shift();
  if (!next) { res.writeHead(500); res.end("Unexpected model request"); return; }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({
    id: "fifo-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  })}\n\n`);
  event({ role: "assistant", ...next });
  event({}, next.tool_calls ? "tool_calls" : "stop", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
  res.end("data: [DONE]\n\n");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "fifo-fixture": {
  api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-fixture-not-a-secret",
  models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 200000,
    maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
let session;
try {
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false });
  const model = modelRuntime.getModel("fifo-fixture", "fixture");
  assert.ok(model);
  const settingsManager = pi.SettingsManager.inMemory({ defaultTools: ["read", "codemode"],
    compaction: { enabled: false }, retry: { enabled: false } });
  const permissionEvents = [];
  const errors = [];
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [mutator, fileURLToPath(new URL("./context.ts", import.meta.url))],
    additionalSkillPaths: [file],
    extensionFactories: [pi.createCodemodeExtension({ mode: "on" }), api => {
      api.on("tool_call", event => { permissionEvents.push(event); });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const loaded = resourceLoader.getExtensions().extensions;
  const mutatorIndex = loaded.findIndex(extension => extension.path === mutator);
  assert.ok(mutatorIndex >= 0 && loaded.findIndex(extension => extension.path.endsWith("/context.ts")) > mutatorIndex,
    "real mutator handler registered before context");
  assert.equal(resourceLoader.getSkills().skills.length, 1);
  ({ session } = await pi.createAgentSession({ cwd, agentDir, modelRuntime, model, resourceLoader,
    settingsManager, sessionManager: pi.SessionManager.inMemory(cwd), thinkingLevel: "off" }));
  session.subscribe(event => { if (event.type === "extension_error") errors.push(event); });
  await session.bindExtensions({ mode: "print" });
  pending.push({ tool_calls: [{ index: 0, id: "fifo-read", type: "function", function: {
    name: "read", arguments: JSON.stringify({ path: file }),
  } }] }, { content: "Retained skill read done." });
  await session.prompt("Read the fixture skill.");
  assert.equal(session.messages.at(-1).stopReason, "stop");
  const result = session.sessionManager.getEntries().findLast(entry => entry.message?.role === "toolResult").message;
  assert.equal(result.toolName, "read");
  assert.equal(result.toolCallId, "fifo-read");
  assert.equal(result.isError, false);
  assert.equal(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"), text,
    "finalized successful transcript retains the actual ordinary file text");
  assert.ok(lstatSync(file).isFIFO());
  assert.deepEqual(session.sessionManager.buildContextEntries().filter(entry => entry.customType === "context:skill_loaded"), []);
  assert.ok(permissionEvents.some(event => event.toolName === "read" && event.input.path === file));
  // Also exercise genuine native codemode/QuickJS and its executeTool pipeline;
  // do not read the FIFO with the native read tool (that is not the repair seam).
  const ordinary = join(cwd, "ordinary.txt");
  writeFileSync(ordinary, "NATIVE-QUICKJS-PIPELINE\n");
  pending.push({ tool_calls: [{ index: 0, id: "fifo-codemode", type: "function", function: {
    name: "codemode", arguments: JSON.stringify({ code: `text(await tools.read({path:${JSON.stringify(ordinary)}}));` }),
  } }] }, { content: "Native follow-up done." });
  await session.prompt("Read the ordinary file through native codemode.");
  assert.equal(session.messages.at(-1).stopReason, "stop");
  assert.ok(permissionEvents.some(event => event.toolName === "read" && event.input.path === ordinary && event.parentToolCallId));
  const nested = session.sessionManager.getEntries().findLast(entry => entry.message?.role === "toolResult").message;
  assert.equal(nested.isError, false);
  assert.ok(nested.content.some(part => part.type === "text" && part.text.includes("NATIVE-QUICKJS-PIPELINE")));
  const requestCount = requests.length;
  await session.prompt("/context");
  assert.equal(requests.length, requestCount);
  const report = session.sessionManager.getEntries().at(-1);
  assert.equal(report.customType, "context:report");
  assert.match(report.data.content, /Loaded skills: \(none\)/);
  assert.deepEqual(errors, []);
  assert.equal(pending.length, 0);
  process.send({ stage: "verified", version, retainedText: text, markerCount: 0, requests: requests.length });
} finally {
  session?.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  process.disconnect();
}
