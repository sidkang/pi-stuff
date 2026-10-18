import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Real CLI/RPC/agent/tools/persistence; only the external provider is a fixture.
// Require an explicit modern host, rather than silently using package-local Pi.
const piPackageDir = process.env.PI_PACKAGE_DIR;
assert.ok(piPackageDir, "Set PI_PACKAGE_DIR to the installed Pi 1.2.0 package directory.");
const piPackage = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"));
assert.equal(piPackage.version, "1.2.0", "This E2E targets the Pi 1.2.0 native provider/codemode/RPC contract.");
const cliPath = join(piPackageDir, "dist", "bundle", "cli.js");
assert.ok(existsSync(cliPath));
const { RpcClient } = await import(pathToFileURL(join(piPackageDir, "dist", "index.js")).href);
const unitDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const patchEntry = resolve(unitDir, "..", "apply-patch", "index.ts");
assert.ok(existsSync(patchEntry), "Run from a checkout containing both delivery units.");

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-codex-tools-e2e-")));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
const sessionDir = join(root, "sessions");
for (const path of [agentDir, cwd, sessionDir]) mkdirSync(path);
const provider = "codex-tools-e2e";
const normalModel = "gpt-e2e";
const requests = [];
const events = [];
const passed = [];
const issuedScripts = new Set();
let sequence = 0;
let failRemoteCompaction = false;
let client;

const scripts = {
	E2E_TOOL_CHAIN: [
		"const patch = await tools.apply_patch({ input: '*** Begin Patch\\n*** Add File: e2e.txt\\n+hello\\n*** End Patch' });",
		"if (typeof patch !== 'object' || !patch.ok) throw new Error('structured results missing');",
		"return { patch };",
	].join("\n"),
	E2E_PATCH_MOVE_NOOP: [
		"const move = await tools.apply_patch({ input: '*** Begin Patch\\n*** Update File: e2e.txt\\n*** Move to: moved.txt\\n@@\\n-hello\\n+world\\n*** End Patch' });",
		"const noop = await tools.apply_patch({ input: '*** Begin Patch\\n*** Update File: moved.txt\\n@@\\n world\\n*** End Patch' });",
		"if (!move.ok || !noop.ok || noop.changedFiles.length !== 0 || noop.noops[0].reason !== 'already_satisfied') throw new Error('move/noop contract failed');",
		"return { move, noop };",
	].join("\n"),

};

function sendEvents(response, streamEvents) {
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const event of streamEvents) response.write(`data: ${JSON.stringify(event)}\n\n`);
	response.end();
}

function sendAssistant(response, model, text, code) {
	const id = `resp_e2e_${++sequence}`;
	const item = code
		? { id: `fc_e2e_${sequence}`, type: "function_call", call_id: `call_e2e_${sequence}`, name: "codemode", arguments: JSON.stringify({ code }), status: "completed" }
		: { id: `msg_e2e_${sequence}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const streamEvents = [{ type: "response.created", response: { id, model, status: "in_progress" } }];
	streamEvents.push({ type: "response.output_item.added", output_index: 0, item: code ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
	if (code) {
		streamEvents.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
		streamEvents.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
	} else {
		streamEvents.push({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
		streamEvents.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text });
		streamEvents.push({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text });
	}
	streamEvents.push({ type: "response.output_item.done", output_index: 0, item });
	streamEvents.push({ type: "response.completed", response: { id, model, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
	sendEvents(response, streamEvents);
}

function userText(body) {
	const user = (Array.isArray(body.input) ? body.input : []).filter((item) => item.role === "user").at(-1);
	if (typeof user?.content === "string") return user.content;
	return (user?.content ?? []).filter((part) => part.type === "input_text").map((part) => part.text).join("\n");
}

const server = createServer(async (request, response) => {
	try {
		assert.equal(request.method, "POST");
		assert.equal(request.url, "/v1/responses");
		assert.equal(request.headers.authorization, "Bearer e2e-fixture-only");
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const kind = body.input?.some((item) => item.type === "compaction_trigger") ? "remote-compaction"
			: !body.tools?.length ? "portable-projection" : "conversation";
		requests.push({ kind, body });
		if (kind === "remote-compaction") {
			if (failRemoteCompaction) {
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: { message: "fixture compaction failure" } }));
			} else sendEvents(response, [
				{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "E2E_SEALED_CHECKPOINT" } },
				{ type: "response.completed", response: { status: "completed", output: [{ type: "compaction", encrypted_content: "E2E_SEALED_CHECKPOINT" }], usage: { input_tokens: 200, output_tokens: 10, total_tokens: 210 } } },
			]);
		} else if (kind === "portable-projection") {
			sendAssistant(response, body.model, "## Goal\nE2E portable checkpoint.\n\n## Progress\nStructured patch results were checked.\n\n## Next Steps\nContinue the E2E test.");
		} else {
			const marker = Object.keys(scripts).find((key) => userText(body).includes(key));
			const code = marker && !issuedScripts.has(marker) ? scripts[marker] : undefined;
			if (code) issuedScripts.add(marker);
			sendAssistant(response, body.model, "E2E_PROVIDER_OK", code);
		}
	} catch (error) {
		requests.push({ kind: "fixture-error", error: String(error) });
		response.writeHead(500, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ error: { message: String(error) } }));
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
	api: "openai-responses", baseUrl, apiKey: "e2e-fixture-only",
	models: [
		{ id: normalModel, name: normalModel, reasoning: false, input: ["text", "image"], contextWindow: 128_000, maxTokens: 512, cost },
	],
} } }));
const settings = {
	defaultTools: ["codemode"], defaultThinkingLevel: "off", defaultProjectTrust: "never",
	cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false,
	transport: "sse", retry: { enabled: false },
	compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 0 },
	codexTools: {
		responsesCompaction: { enabled: true, providers: [provider] },
	},
};
function saveSettings() { writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings)); }
saveSettings();
function makeClient(extraArgs = [], loadCodex = true) {
	const extensions = ["--extension", "builtin:codemode", "--extension", patchEntry];
	if (loadCodex) extensions.push("--extension", join(unitDir, "index.ts"));
	return new RpcClient({
		cliPath, cwd, provider, model: normalModel,
		env: { PI_PACKAGE_DIR: piPackageDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
		args: ["--session-dir", sessionDir, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", ...extensions, ...extraArgs],
	});
}

function terminalTool(runEvents, name, isError = false) {
	const terminal = runEvents.find((event) => event.type === "tool_execution_end" && event.toolName === name && Boolean(event.isError) === isError);
	assert.ok(terminal, `missing terminal ${name} isError=${isError}`);
	return terminal;
}
function scriptResult(runEvents) {
	const terminal = terminalTool(runEvents, "codemode");
	assert.equal(terminal.result.isError, undefined);
	return JSON.parse(terminal.result.content.at(-1).text);
}
function record(name) { passed.push(name); console.log(`PASS ${name}`); }
function count(kind) { return requests.filter((request) => request.kind === kind).length; }

try {
	client = makeClient();
	client.onEvent((event) => events.push(event));
	await client.start();
	assert.equal((await client.getState()).model.id, normalModel);
	assert.ok((await client.getCommands()).some((command) => command.name === "codex-review"));
	const chainEvents = await client.promptAndWait("E2E_TOOL_CHAIN", undefined, 30_000);
	const chain = scriptResult(chainEvents);
	assert.equal(chain.patch.ok, true);
	assert.deepEqual(chain.patch.changedFiles, ["e2e.txt"]);
	assert.equal(readFileSync(join(cwd, "e2e.txt"), "utf8"), "hello\n");
	record("real agent -> native codemode -> apply_patch -> structured objects and files");

	const moved = scriptResult(await client.promptAndWait("E2E_PATCH_MOVE_NOOP", undefined, 30_000));
	assert.equal(moved.move.files[0].moveTo, "moved.txt");
	assert.deepEqual(moved.noop.changedFiles, []);
	assert.equal(moved.noop.noops[0].reason, "already_satisfied");
	assert.equal(existsSync(join(cwd, "e2e.txt")), false);
	assert.equal(readFileSync(join(cwd, "moved.txt"), "utf8"), "world\n");
	record("patch moves/no-ops retain native success and structured metadata");

	const compacted = await client.compact();
	assert.match(compacted.summary, /E2E portable checkpoint/);
	const remote = compacted.details.remoteResponsesCompaction;
	assert.equal(remote.telemetry.inputTokens, 200);
	assert.equal(remote.telemetry.outputTokens, 10);
	assert.equal("requestBudget" in remote.telemetry, false);
	assert.equal(remote.history.at(-1).encrypted_content, "E2E_SEALED_CHECKPOINT");
	assert.equal(count("remote-compaction"), 1);
	const checkpointCount = (await client.getEntries()).entries.filter((entry) => entry.type === "compaction").length;
	assert.equal(checkpointCount, 1);
	await client.promptAndWait("E2E_POST_COMPACTION", undefined, 30_000);
	assert.ok(requests.filter((request) => request.kind === "conversation").at(-1).body.input.some((item) => item.type === "compaction"), "compatible continuation must replay the checkpoint");
	record("complete compaction pair persists provider telemetry and replays checkpoint");

	const remoteBefore = count("remote-compaction");
	const projectionBefore = count("portable-projection");
	failRemoteCompaction = true;
	await assert.rejects(() => client.compact(), /cancel/i);
	assert.equal(count("remote-compaction"), remoteBefore + 1);
	// Pi may generate both a history summary and a split-turn prefix summary.
	const projectionAfter = count("portable-projection");
	assert.ok(projectionAfter > projectionBefore, "the sibling projection still runs");
	assert.equal((await client.getEntries()).entries.filter((entry) => entry.type === "compaction").length, checkpointCount);
	failRemoteCompaction = false;
	const retried = await client.compact();
	assert.match(retried.summary, /E2E portable checkpoint/);
	assert.equal(count("portable-projection"), projectionAfter, "unchanged retry must reuse the completed projection");
	assert.equal(count("remote-compaction"), remoteBefore + 2);
	assert.equal((await client.getEntries()).entries.filter((entry) => entry.type === "compaction").length, checkpointCount + 1);
	record("provider failure preserves the independent projection and retries only the failed component");

	const sessionFile = (await client.getState()).sessionFile;
	assert.ok(sessionFile && existsSync(sessionFile));
	await client.stop();
	settings.codexTools.responsesCompaction.enabled = false;
	saveSettings();
	client = makeClient(["--session", sessionFile], false);
	client.onEvent((event) => events.push(event));
	await client.start();
	await client.promptAndWait("E2E_PORTABLE_RESUME", undefined, 30_000);
	const resumed = requests.filter((request) => request.kind === "conversation").at(-1).body;
	assert.equal(resumed.input.some((item) => item.type === "compaction"), false);
	assert.match(JSON.stringify(resumed.input), /E2E portable checkpoint/);
	record("persisted session resumes without Codex Tools using the real portable projection");
	assert.equal(count("fixture-error"), 0);
} catch (error) {
	console.error(`FAIL ${error.stack ?? error}`);
	process.exitCode = 1;
} finally {
	if (client) {
		writeFileSync(join(root, "stderr.log"), client.getStderr());
		await client.stop();
	}
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2));
	writeFileSync(join(root, "events.json"), JSON.stringify(events, null, 2));
	writeFileSync(join(root, "report.json"), JSON.stringify({
		ok: process.exitCode !== 1, piVersion: piPackage.version,
		scope: "real Pi CLI/RPC with local HTTP/SSE provider fixtures; no production requests or installation",
		passed, counts: { conversation: count("conversation"), portableProjection: count("portable-projection"), remoteCompaction: count("remote-compaction") },
	}, null, 2));
	console.log(`E2E artifacts: ${root}`);
}
