import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Value } from "typebox/value";
import { ApplyPatchOutputSchema, buildApplyPatchOutput } from "./apply-patch-output.ts";
import { findPiHost } from "./pi-host-test-helper.mjs";

const patch = (body) => `*** Begin Patch\n${body ? `${body}\n` : ""}*** End Patch`;
const nested = (body) => `return await tools.apply_patch(${JSON.stringify({ input: patch(body) })});`;
const noop = (path, actionIndex = 0) => ({ path, actionIndex, hunkIndex: 0, startLine: 1, endLine: 1, reason: "already_satisfied" });

// Only the provider boundary is scripted. Resource discovery, extension loading,
// the agent loop, permissions, executeTool and QuickJS codemode are the real host.
test("actual Pi session: direct and native codemode patch workflows", { timeout: 120_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "apply-patch-pi-e2e-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	mkdirSync(agentDir, { mode: 0o700 });
	mkdirSync(cwd, { mode: 0o700 });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	let session;
	try {
		const host = await findPiHost();
		console.log(`Actual Pi host: ${host.version} (${host.root}); loaded SDK VERSION=${host.sdk.VERSION}`);
		const sdk = host.sdk;
		const requireHost = createRequire(join(host.root, "package.json"));
		const aiPath = requireHost.resolve.paths("@earendil-works/pi-ai")
			.map((dir) => join(dir, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
		assert.ok(aiPath, "the actual host's pi-ai dependency is required");
		const ai = await import(pathToFileURL(aiPath).href);
		const responses = [];
		const permissions = [];
		const executions = [];
		const nestedResults = [];
		let block = false;
		let api;
		let sequence = 0;
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ["apply_patch", "codemode"] });
		const resourceLoader = new sdk.DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
			extensionFactories: [
				sdk.createCodemodeExtension({ mode: "on", models: false }),
				(pi) => {
					api = pi;
					pi.registerProvider("apply-patch-fixture", {
						api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture-not-a-credential",
						models: ["gpt-fixture", "claude-fixture"].map((id) => ({ id, name: id, input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
						streamSimple(model) {
							assert.ok(responses.length, "scripted provider response queue must not be exhausted");
							const content = responses.shift();
							const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
							const stream = ai.createAssistantMessageEventStream();
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: message.stopReason, message });
							return stream;
						},
					});
					pi.on("tool_call", (event) => {
						if (event.toolName !== "apply_patch") return;
						permissions.push(event);
						if (block) return { block: true, reason: "fixture permission denied" };
					});
					pi.on("tool_result", (event) => {
						if (event.toolName === "apply_patch") nestedResults.push(event);
					});
				},
			],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
		const model = { provider: "apply-patch-fixture", id: "gpt-fixture", name: "gpt-fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		({ session } = await sdk.createAgentSession({ cwd, agentDir, model, modelRuntime, resourceLoader, settingsManager, thinkingLevel: "off", tools: ["apply_patch", "codemode"], sessionManager: sdk.SessionManager.inMemory(cwd) }));
		await session.bindExtensions({});
		session.subscribe((event) => { if (event.type.startsWith("tool_execution_")) executions.push(event); });

		async function run(name, args) {
			const id = `script-${++sequence}`;
			responses.push([{ type: "toolCall", id, name, arguments: args }], [{ type: "text", text: "done" }]);
			await session.prompt("Run the deterministic fixture tool call.");
			assert.equal(responses.length, 0);
			const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
			assert.ok(result, "real session persisted the parent result");
			return result;
		}
		const runCode = (code) => run("codemode", { code });
		const text = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		const success = (result) => assert.equal(result.isError, false, text(result));
		function checkOutput(result) {
			assert.equal(Value.Check(ApplyPatchOutputSchema, result.structuredContent), true, JSON.stringify(result));
			assert.deepEqual(result.structuredContent, buildApplyPatchOutput(result.details));
			assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(cwd));
		}
		// Validate the public object inside QuickJS as well as the actual execution
		// event. No outcome alias: changedFiles and noops describe no-op behavior.
		const consume = (body, expected) => `const result = await tools.apply_patch(${JSON.stringify({ input: patch(body) })}); const actual = { changedFiles: result.changedFiles, files: result.files, noops: result.noops }; if (result.ok !== true || typeof result.summary !== "string" || JSON.stringify(actual) !== ${JSON.stringify(JSON.stringify(expected))}) throw Error("Unexpected structured patch output: " + JSON.stringify(result)); return result;`;

		await t.test("direct calling stays active with destructive hints and preserves text/details", async () => {
			assert.ok(session.getActiveToolNames().includes("apply_patch"));
			const definition = api.getAllTools().find((tool) => tool.name === "apply_patch");
			assert.equal(definition.exposure, "direct");
			assert.deepEqual(definition.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
			const result = await run("apply_patch", { input: patch("*** Add File: direct.txt\n+direct") });
			success(result);
			// Direct transcript messages persist content/details, not structuredContent.
			const executed = executions.find((event) => event.type === "tool_execution_end" && event.toolCallId === result.toolCallId);
			checkOutput(executed.result);
			assert.deepEqual(executed.result.structuredContent.files, [{ kind: "add", path: "direct.txt" }]);
			assert.deepEqual(result.details.changedFiles, ["direct.txt"]);
			assert.match(text(result), /Files changed: direct.txt/);
			assert.equal(readFileSync(join(cwd, "direct.txt"), "utf8"), "direct\n");
			for (const [body, expected] of [
				["*** Update File: direct.txt\n@@\n-direct\n+updated", { changedFiles: ["direct.txt"], files: [{ kind: "update", path: "direct.txt" }], noops: [] }],
				["*** Update File: direct.txt\n@@\n updated", { changedFiles: [], files: [{ kind: "update", path: "direct.txt" }], noops: [noop("direct.txt")] }],
				["*** Update File: direct.txt\n@@\n updated\n*** Add File: direct-mixed.txt\n+mixed", { changedFiles: ["direct-mixed.txt"], files: [{ kind: "update", path: "direct.txt" }, { kind: "add", path: "direct-mixed.txt" }], noops: [noop("direct.txt")] }],
				["*** Update File: direct.txt\n*** Move to: direct-moved.txt", { changedFiles: ["direct-moved.txt", "direct.txt"], files: [{ kind: "update", path: "direct.txt", moveTo: "direct-moved.txt" }], noops: [] }],
				["*** Delete File: direct-moved.txt", { changedFiles: ["direct-moved.txt"], files: [{ kind: "delete", path: "direct-moved.txt" }], noops: [] }],
			]) {
				const direct = await run("apply_patch", { input: patch(body) });
				success(direct);
				const event = executions.find((event) => event.type === "tool_execution_end" && event.toolCallId === direct.toolCallId);
				checkOutput(event.result);
				const { changedFiles, files, noops } = event.result.structuredContent;
				assert.deepEqual({ changedFiles, files, noops }, expected);
			}
		});

		await t.test("native codemode consumes current add/update/all-noop/mixed/move/delete objects", async () => {
			for (const [body, expected] of [
				["*** Add File: nested.txt\n+old", { changedFiles: ["nested.txt"], files: [{ kind: "add", path: "nested.txt" }], noops: [] }],
				["*** Update File: nested.txt\n@@\n-old\n+new", { changedFiles: ["nested.txt"], files: [{ kind: "update", path: "nested.txt" }], noops: [] }],
				["*** Update File: nested.txt\n@@\n-new\n+new", { changedFiles: [], files: [{ kind: "update", path: "nested.txt" }], noops: [noop("nested.txt")] }],
				["*** Update File: nested.txt\n@@\n new\n*** Add File: mixed.txt\n+mixed", { changedFiles: ["mixed.txt"], files: [{ kind: "update", path: "nested.txt" }, { kind: "add", path: "mixed.txt" }], noops: [noop("nested.txt")] }],
				["*** Update File: nested.txt\n*** Move to: moved.txt", { changedFiles: ["moved.txt", "nested.txt"], files: [{ kind: "update", path: "nested.txt", moveTo: "moved.txt" }], noops: [] }],
				["*** Delete File: moved.txt", { changedFiles: ["moved.txt"], files: [{ kind: "delete", path: "moved.txt" }], noops: [] }],
			]) {
				const result = await runCode(consume(body, expected));
				success(result);
				const event = executions.findLast((event) => event.type === "tool_execution_end" && event.parentToolCallId === result.toolCallId && event.toolName === "apply_patch");
				checkOutput(event.result);
				assert.deepEqual(JSON.parse(result.content.at(-1).text), event.result.structuredContent);
			}
			const nestedPermissions = permissions.filter((event) => event.parentToolCallId);
			assert.equal(nestedPermissions.length, 6);
			for (const event of nestedPermissions) {
				assert.ok(event.toolCallId.startsWith(`${event.parentToolCallId}/`));
				assert.ok(executions.some((execution) => execution.type === "tool_execution_end" && execution.toolCallId === event.toolCallId && execution.parentToolCallId === event.parentToolCallId));
			}
			assert.ok(nestedResults.some((result) => result.structuredContent?.changedFiles.length === 0 && result.structuredContent.noops.length === 1));
		});

		await t.test("permission, empty/malformed/rejected/path-escape/symlink failures preserve files and stay errors", async () => {
			writeFileSync(join(cwd, "protected.txt"), "keep\n");
			writeFileSync(join(root, "outside.txt"), "outside\n");
			symlinkSync(root, join(cwd, "link"), "dir");
			block = true;
			const blocked = await runCode(nested("*** Delete File: protected.txt"));
			assert.equal(blocked.isError, true);
			assert.match(text(blocked), /fixture permission denied/);
			assert.equal(permissions.at(-1).parentToolCallId, blocked.toolCallId);
			block = false;
			for (const body of ["", "malformed", "*** Update File: protected.txt\n@@\n-missing\n+changed", "*** Update File: ../outside.txt\n@@\n-outside\n+changed", "*** Update File: link/outside.txt\n@@\n-outside\n+changed"]) {
				const result = await runCode(nested(body));
				assert.equal(result.isError, true, text(result));
				const event = executions.findLast((event) => event.type === "tool_execution_end" && event.parentToolCallId === result.toolCallId && event.toolName === "apply_patch");
				assert.equal(event.result.structuredContent, undefined);
				assert.equal(readFileSync(join(cwd, "protected.txt"), "utf8"), "keep\n");
				assert.equal(readFileSync(join(root, "outside.txt"), "utf8"), "outside\n");
			}
			const directError = await run("apply_patch", { input: patch("malformed") });
			assert.equal(directError.isError, true);
			assert.equal(directError.structuredContent, undefined);
			assert.equal((await runCode("return await tools.apply_patch({ input: 42 });")).isError, true);
			assert.equal(readFileSync(join(cwd, "protected.txt"), "utf8"), "keep\n");
		});

		await t.test("inactive and wrong-model nested calls reject before mutation", async () => {
			session.setActiveToolsByName(["codemode"]);
			const permissionCount = permissions.length;
			assert.equal((await runCode(nested("*** Add File: inactive.txt\n+bad"))).isError, true);
			assert.equal(permissions.length, permissionCount);
			assert.equal(existsSync(join(cwd, "inactive.txt")), false);
			session.setActiveToolsByName(["apply_patch", "codemode"]);
			await session.setModel(modelRuntime.getModel("apply-patch-fixture", "claude-fixture"));
			assert.equal(session.getActiveToolNames().includes("apply_patch"), false);
			assert.equal((await runCode(nested("*** Add File: wrong-model.txt\n+bad"))).isError, true);
			assert.equal(permissions.length, permissionCount);
			assert.equal(existsSync(join(cwd, "wrong-model.txt")), false);
			await session.setModel(modelRuntime.getModel("apply-patch-fixture", "gpt-fixture"));
			assert.ok(session.getActiveToolNames().includes("apply_patch"));
		});

		await t.test("Workspace Authority v2 unavailable fails closed before any host mutation", async () => {
			const unsubscribe = api.events.on("sandbox:workspace-access:query:v2", (query) => query.provide({ kind: "unavailable", reason: "fixture unavailable" }));
			try {
				const result = await runCode(nested("*** Add File: unavailable.txt\n+bad"));
				assert.equal(result.isError, true);
				assert.match(text(result), /fixture unavailable/);
				assert.equal(existsSync(join(cwd, "unavailable.txt")), false);
			} finally { unsubscribe(); }
		});

		await t.test("physical Host failure rolls back confirmed writes and preserves competing foreign bytes", { timeout: 15_000 }, async () => {
			for (const conflict of [false, true]) {
				const directory = conflict ? "rollback-conflict" : "rollback-restored";
				const scenario = join(cwd, directory);
				mkdirSync(scenario, { mode: 0o700 });
				const first = join(scenario, "a.txt");
				const marker = join(scenario, "b-marker.txt");
				const blocker = join(scenario, "z-blocker");
				writeFileSync(first, "old\n");
				writeFileSync(marker, "checkpoint old\n");
				writeFileSync(blocker, "protected regular-file ancestor\n");
				let observed;
				let actorError;
				// commitPlan orders paths lexically. Mutation of b-marker is a
				// physical witness that a's write AND journal verification completed.
				// The watcher is an ordinary filesystem observer/competing writer;
				// it never hooks an adapter, queue, tool, session or SDK method.
				// Watch the existing file, not a directory (whose notifications may
				// be coalesced). React to real changed bytes, never a timer or retry.
				const watcher = watch(marker, { signal: AbortSignal.timeout(10_000) }, () => {
					if (observed || actorError) return;
					try {
						if (readFileSync(marker, "utf8") === "checkpoint old\n") return;
						const written = readFileSync(first, "utf8");
						assert.equal(written, "new\n", "first actual write must be witnessed before rollback");
						observed = { firstWrittenBytes: written, checkpointMutation: true, foreignWrite: conflict };
						if (conflict) writeFileSync(first, "foreign actor bytes\n");
					} catch (error) { actorError = error; }
					finally { if (observed || actorError) watcher.close(); }
				});
				watcher.on("error", (error) => { actorError = error; });
				try {
					// inspect treats ENOTDIR as missing, so z-blocker/child passes
					// planning. Only the real Host ensureParents rejects its regular
					// file ancestor, after the earlier two physical mutations.
					const result = await runCode(nested(`*** Update File: ${directory}/a.txt\n@@\n-old\n+new\n*** Update File: ${directory}/b-marker.txt\n@@\n-checkpoint old\n+checkpoint new\n*** Add File: ${directory}/z-blocker/child.txt\n+unreachable`));
					assert.ifError(actorError);
					assert.equal(result.isError, true);
					assert.match(text(result), /Parent path is not a directory: .*z-blocker/);
					assert.deepEqual(observed, { firstWrittenBytes: "new\n", checkpointMutation: true, foreignWrite: conflict }, text(result));
					assert.match(text(result), conflict ? /Rollback conflict: .*a\.txt no longer matches the state written by this operation/ : /Rolled back all touched files/);
					const event = executions.findLast((event) => event.type === "tool_execution_end" && event.parentToolCallId === result.toolCallId && event.toolName === "apply_patch");
					assert.equal(event.isError, true);
					assert.equal(event.result.structuredContent, undefined);
					assert.equal(readFileSync(first, "utf8"), conflict ? "foreign actor bytes\n" : "old\n");
					assert.equal(readFileSync(marker, "utf8"), "checkpoint old\n", "the actually mutated second file must be rolled back");
					assert.equal(readFileSync(blocker, "utf8"), "protected regular-file ancestor\n");
					assert.equal(existsSync(join(blocker, "child.txt")), false);
					console.log(`Physical Host ${conflict ? "rollback conflict" : "rollback"}: ${JSON.stringify(observed)}; ${text(event.result)}`);
				} finally { watcher.close(); }
			}
		});

		await t.test("concurrent same-file nested calls serialize complete read-modify-write operations", async () => {
			writeFileSync(join(cwd, "queued.txt"), "zero\n");
			const first = { input: patch("*** Update File: queued.txt\n@@\n-zero\n+one") };
			const second = { input: patch("*** Update File: queued.txt\n@@\n-one\n+two") };
			success(await runCode(`const results = await Promise.all([tools.apply_patch(${JSON.stringify(first)}), tools.apply_patch(${JSON.stringify(second)})]); if (results.some(r => r.ok !== true || r.changedFiles[0] !== "queued.txt" || r.noops.length !== 0)) throw Error("queue failure"); return results;`));
			assert.equal(readFileSync(join(cwd, "queued.txt"), "utf8"), "two\n");
		});

		await t.test("session cancellation reaches a running nested patch before mutation", async () => {
			writeFileSync(join(cwd, "cancelled.txt"), "keep\n");
			let cancellation;
			let sawUpdate = false;
			let cancelledToolCallId;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "tool_execution_update" && event.toolName === "apply_patch" && event.parentToolCallId) {
					sawUpdate = true;
					cancelledToolCallId = event.toolCallId;
					cancellation = session.abort();
				}
			});
			responses.push([{ type: "toolCall", id: `script-${++sequence}`, name: "codemode", arguments: { code: nested("*** Delete File: cancelled.txt") } }]);
			try {
				await session.prompt("Run the cancelled fixture.");
				await cancellation;
			} finally { unsubscribe(); }
			assert.equal(sawUpdate, true);
			assert.equal(responses.length, 0);
			assert.equal(readFileSync(join(cwd, "cancelled.txt"), "utf8"), "keep\n");
			const cancelled = executions.find((event) => event.type === "tool_execution_end" && event.toolCallId === cancelledToolCallId);
			assert.equal(cancelled.isError, true);
			assert.equal(cancelled.result.structuredContent, undefined);
			assert.match(text(cancelled.result), /abort/i);
		});
	} finally {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
		rmSync(root, { recursive: true, force: true });
	}
});
