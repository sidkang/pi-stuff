import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { createMockContext, createMockFunction, createMockPi } from "../../tests/extension-harness.mjs";

type ContextModule = {
	default(pi: any): void;
	__test: {
		observeDeclarations(payload: unknown): Map<string, number> | null;
		buildToolInventory(pi: any, declarations: Map<string, number> | null): any[];
		getLoadedSkillsFromSession(ctx: any): Map<string, number>;
		sanitizeDisplayText(value: string): string;
		sumSessionUsage(ctx: any): {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			totalCost: number;
		};
	};
};

const sandboxes: string[] = [];

function writePackage(dir: string, name: string, source: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }, null, 2));
	writeFileSync(join(dir, "index.js"), source);
}

async function loadContextModule(): Promise<ContextModule> {
	const sandbox = join(tmpdir(), `context-extension-${process.pid}-${sandboxes.length}`);
	sandboxes.push(sandbox);
	const extensionDir = join(sandbox, "extensions");
	mkdirSync(extensionDir, { recursive: true });
	copyFileSync(new URL("./context.ts", import.meta.url), join(extensionDir, "context.ts"));

	const nodeModules = join(sandbox, "node_modules");
	writePackage(
		join(nodeModules, "@earendil-works", "pi-coding-agent"),
		"@earendil-works/pi-coding-agent",
		`export class DynamicBorder { render() { return []; } invalidate() {} }`,
	);
	writePackage(
		join(nodeModules, "@earendil-works", "pi-tui"),
		"@earendil-works/pi-tui",
		`
			export class Container {
				children = [];
				addChild(child) { this.children.push(child); }
				invalidate() { for (const child of this.children) child.invalidate?.(); }
				render(width) { return this.children.flatMap((child) => child.render?.(width) ?? []); }
			}
			export class Text {
				constructor(text = "") { this.text = text; }
				setText(text) { this.text = text; }
				invalidate() {}
				render() { return String(this.text).split("\\n"); }
			}
			export const Key = { tab: "tab", escape: "escape", ctrl: (key) => "ctrl+" + key };
			export const matchesKey = (data, key) => data === key;
			export const visibleWidth = (value) => String(value).replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, "").length;
			export const truncateToWidth = (value, width, ellipsis = "") => {
				const text = String(value);
				return text.length <= width ? text : text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
			};
		`,
	);

	return import(`${pathToFileURL(join(extensionDir, "context.ts")).href}?case=${sandboxes.length}`);
}

const contextModule = await loadContextModule();

after(() => {
	while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("context extension", () => {
	it("aggregates every billed session usage source with Pi's current field names", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: usage(100, 20, 5, 3, 0.1) } },
			{ type: "message", message: { role: "toolResult", usage: usage(10, 2, 1, 0, 0.02) } },
			{ type: "compaction", usage: usage(30, 4, 0, 0, 0.03) },
			{ type: "branch_summary", usage: usage(40, 5, 2, 1, 0.04) },
		];
		const ctx = createMockContext({ entries });

		const total = contextModule.__test.sumSessionUsage(ctx);
		assert.deepEqual({ ...total, totalCost: undefined }, {
			input: 180,
			output: 31,
			cacheRead: 8,
			cacheWrite: 4,
			totalTokens: 223,
			totalCost: undefined,
		});
		assert.ok(Math.abs(total.totalCost - 0.19) < 1e-12);
	});

	it("uses only active context entries for loaded-skill accounting", () => {
		const active = {
			type: "custom",
			customType: "context:skill_loaded",
			data: { name: "active-skill", path: "/skills/active/SKILL.md", tokens: 25 },
		};
		const sibling = {
			type: "custom",
			customType: "context:skill_loaded",
			data: { name: "sibling-skill", path: "/skills/sibling/SKILL.md", tokens: 50 },
		};
		const ctx = createMockContext({
			entries: [active, sibling],
			sessionManager: { buildContextEntries: createMockFunction(() => [active]) },
		});

		assert.deepEqual([...contextModule.__test.getLoadedSkillsFromSession(ctx)], [["active-skill", 25]]);
	});

	it("records only exact SKILL.md reads and counts returned content", async () => {
		const root = join(tmpdir(), `context-skill-${process.pid}`);
		sandboxes.push(root);
		const skillDir = join(root, "demo-skill");
		mkdirSync(join(skillDir, "scripts"), { recursive: true });
		const skillFile = join(skillDir, "SKILL.md");
		writeFileSync(skillFile, "---\nname: demo-skill\ndescription: demo\n---\n\n# Demo\n");
		writeFileSync(join(skillDir, "scripts", "helper.ts"), "export {};\n");

		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{
			name: "skill:demo-skill",
			description: "demo",
			source: "skill",
			sourceInfo: { path: skillFile },
		}]);
		contextModule.default(harness.pi);
		const [handler] = harness.handlers.get("tool_result");
		const ctx = createMockContext({
			cwd: root,
			sessionManager: { buildContextEntries: createMockFunction(() => []) },
		});

		await handler({
			type: "tool_result",
			toolName: "read",
			isError: false,
			input: { path: join(skillDir, "scripts", "helper.ts") },
			content: [{ type: "text", text: "export {};" }],
		}, ctx);
		assert.equal(harness.entries.length, 0);

		await handler({
			type: "tool_result",
			toolCallId: "direct",
			toolName: "read",
			isError: false,
			input: { path: skillFile, offset: 6 },
			content: [{ type: "text", text: "# Demo" }],
		}, ctx);
		assert.equal(harness.entries.length, 0, "wait for finalized transcript output");
		await harness.handlers.get("turn_end")[0]({ toolResults: [{
			role: "toolResult", toolCallId: "direct", toolName: "read", isError: false,
			content: [{ type: "text", text: "# Demo" }],
		}] }, ctx);
		assert.equal(harness.entries.length, 1);
		assert.equal(harness.entries[0][0], "context:skill_loaded");
		assert.equal(harness.entries[0][1].name, "demo-skill");
		assert.equal(harness.entries[0][1].tokens, 2);
	});

	it("records explicit expanded skill commands from validated user blocks", async () => {
		const root = join(tmpdir(), `context-expanded-skill-${process.pid}`);
		sandboxes.push(root);
		const skillDir = join(root, "demo-skill");
		mkdirSync(skillDir, { recursive: true });
		const skillFile = join(skillDir, "SKILL.md");
		writeFileSync(skillFile, "# Demo\n");

		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{
			name: "skill:demo-skill",
			description: "demo",
			source: "skill",
			sourceInfo: { path: skillFile },
		}]);
		contextModule.default(harness.pi);
		const [handler] = harness.handlers.get("message_end");
		const ctx = createMockContext({
			cwd: root,
			sessionManager: { buildContextEntries: createMockFunction(() => []) },
		});

		await handler({
			type: "message_end",
			message: {
				role: "user",
				content: `<skill name="demo-skill" location="${skillFile}">\nReferences are relative.\n\n# Demo\n</skill>`,
			},
		}, ctx);

		assert.equal(harness.entries.length, 1);
		assert.equal(harness.entries[0][1].name, "demo-skill");
	});

	it("counts finalized direct skill prefixes and removed notices, but not failed or unrelated output", async () => {
		const root = join(tmpdir(), `context-direct-retained-${process.pid}`);
		sandboxes.push(root);
		mkdirSync(root, { recursive: true });
		const file = join(root, "SKILL.md");
		writeFileSync(file, "# Demo\nFull skill instructions\n");
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{ name: "skill:demo", source: "skill", sourceInfo: { path: file } }]);
		contextModule.default(harness.pi);
		const ctx = createMockContext({ cwd: root });
		const cases = [
			{ original: "# Demo\nFull skill instructions\n", final: "# Demo\n", accepted: true },
			{ original: "# Demo\n\n[3 more lines in file. Use offset=2 to continue.]", final: "# Demo", accepted: true },
			{ original: "# Demo\n\n[Showing lines 1-1 of 4 (50KB limit). Use offset=2 to continue.]", final: "# Demo", accepted: true },
			{ original: "# Demo\nFull skill instructions\n", final: "# Demo\n", accepted: false, isError: true },
			{ original: "# Demo\nFull skill instructions\n", final: "", accepted: false },
			{ original: "# Demo\nFull skill instructions\n", final: "entirely redacted", accepted: false },
			{ original: "# Demo\n\n[3 more lines in file. Use offset=2 to continue.]", final: "[3 more lines in file. Use offset=2 to continue.]", accepted: false },
		];
		for (const [index, item] of cases.entries()) {
			const before = harness.entries.length;
			const toolCallId = `direct-retained-${index}`;
			await harness.handlers.get("tool_result")[0]({ toolName: "read", toolCallId,
				isError: false, input: { path: file }, content: [{ type: "text", text: item.original }],
			}, ctx);
			await harness.handlers.get("turn_end")[0]({ toolResults: [{ role: "toolResult", toolName: "read",
				toolCallId, isError: !!item.isError, content: [{ type: "text", text: item.final }],
			}] }, ctx);
			assert.equal(harness.entries.length, before + Number(item.accepted), `case ${index}`);
			if (item.accepted) assert.equal(harness.entries.at(-1)[1].tokens, Math.ceil(item.final.length / 4));
		}
	});

	it("preserves literal continuation suffixes through direct finalization and strips only an evidenced appended notice", async () => {
		const root = join(tmpdir(), `context-literal-notice-${process.pid}`);
		sandboxes.push(root);
		mkdirSync(root, { recursive: true });
		const file = join(root, "SKILL.md");
		const literal = "# Demo\n\n[3 more lines in file. Use offset=2 to continue.]";
		writeFileSync(file, literal + "\nRemaining text\n");
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{ name: "skill:demo", source: "skill", sourceInfo: { path: file } }]);
		contextModule.default(harness.pi);
		const ctx = createMockContext({ cwd: root });
		const notice = "\n\n[2 more lines in file. Use offset=4 to continue.]";
		const collision = "# Demo" + notice;
		for (const [index, item] of [
			{ original: literal, final: literal, retained: literal },
			{ original: literal, final: "Read wrapper:\n" + literal, retained: "Read wrapper:\n" + literal },
			{ original: literal + notice, final: literal + notice, retained: literal },
			{ original: literal + notice, final: literal, retained: literal },
			{ original: literal + notice, final: "Read wrapper:\n" + literal + notice, retained: "Read wrapper:\n" + literal },
			{ original: literal + notice, final: "# Demo", retained: "# Demo" },
			{ original: literal, final: literal + notice, retained: literal + notice },
			{ source: collision, original: collision + notice, final: collision, retained: collision },
			{ source: collision, original: collision + notice, final: "Read wrapper:\n" + collision, retained: "Read wrapper:\n" + collision },
		].entries()) {
			writeFileSync(file, (item.source ?? literal) + "\nRemaining text\n");
			const toolCallId = `literal-${index}`;
			const before = harness.entries.length;
			await harness.handlers.get("tool_result")[0]({ toolName: "read", toolCallId, isError: false,
				input: { path: file, limit: 3 }, content: [{ type: "text", text: item.original }],
			}, ctx);
			await harness.handlers.get("turn_end")[0]({ toolResults: [{ role: "toolResult", toolName: "read", toolCallId,
				isError: false, content: [{ type: "text", text: item.final }],
			}] }, ctx);
			assert.equal(harness.entries.length, before + 1, `literal case ${index} stays loaded`);
			assert.equal(harness.entries.at(-1)[1].tokens, Math.ceil(item.retained.length / 4), `literal case ${index} counts exact retained source/wrapper text`);
		}
	});

	it("requires each nested read's own finalized success even when a catching parent emits full error text", async () => {
		const root = join(tmpdir(), `context-nested-finalized-${process.pid}`);
		sandboxes.push(root);
		mkdirSync(root, { recursive: true });
		const file = join(root, "SKILL.md");
		const full = "# Finalized nested skill\nComplete instructions\n";
		writeFileSync(file, full);
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{ name: "skill:demo", source: "skill", sourceInfo: { path: file } }]);
		contextModule.default(harness.pi);
		const ctx = createMockContext({ cwd: root });
		for (const [index, outcome] of ["failed", "missing", "partial", "success"].entries()) {
			const parent = `catching-parent-${index}`;
			const id = `${parent}/1`;
			const before = harness.entries.length;
			await harness.handlers.get("tool_result")[0]({ toolName: "read", toolCallId: id,
				parentToolCallId: parent, isError: false, input: { path: file }, content: [{ type: "text", text: full }],
			}, ctx);
			// A successful different child of this same parent cannot certify this read.
			await harness.handlers.get("tool_execution_end")[0]({ toolName: "read", toolCallId: `${parent}/2`,
				parentToolCallId: parent, isError: false, result: { content: [{ type: "text", text: full }] },
			}, ctx);
			if (outcome !== "missing") await harness.handlers.get("tool_execution_end")[0]({ toolName: "read", toolCallId: id,
				parentToolCallId: parent, isError: outcome === "failed",
				result: { content: [{ type: "text", text: outcome === "partial" ? full.slice(0, 10) : full }] },
			}, ctx);
			await harness.handlers.get("turn_end")[0]({ toolResults: [{ role: "toolResult", toolName: "codemode",
				toolCallId: parent, isError: false, content: [{ type: "text", text: full }],
			}] }, ctx);
			assert.equal(harness.entries.length, before + Number(outcome === "success"), outcome);
		}
	});

	it("verifies requested filesystem text before direct tracking and never counts native notices", async () => {
		const root = join(tmpdir(), `context-direct-source-${process.pid}`);
		sandboxes.push(root);
		mkdirSync(root, { recursive: true });
		const file = join(root, "SKILL.md");
		writeFileSync(file, `# Skill\n${"X".repeat(51201)}\nRequested offset text\nFinal line\n`);
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{ name: "skill:demo", source: "skill", sourceInfo: { path: file } }]);
		contextModule.default(harness.pi);
		const ctx = createMockContext({ cwd: root });
		const notice = "\n\n[2 more lines in file. Use offset=4 to continue.]";
		const cases = [
			{ input: { offset: 2, limit: 1 }, original: "[Line 2 is 50.0KB, exceeds 50.0KB limit. Use bash: sed -n '2p' SKILL.md | head -c 51200]", accepted: false },
			{ input: { offset: 3, limit: 1 }, original: "[skill read redacted]", accepted: false },
			{ input: { offset: 3, limit: 1 }, original: "Requested offset text" + notice, accepted: true, retained: "Requested offset text" },
			{ input: { offset: 3, limit: 2 }, original: "Requested offset text\nFinal line", final: "Requested offset", accepted: true, retained: "Requested offset" },
			{ input: { offset: 4, limit: 1 }, original: "Requested offset text", accepted: false },
			{ input: { offset: 3.5, limit: 1 }, original: "Requested offset text", accepted: false },
		];
		for (const [index, item] of cases.entries()) {
			const before = harness.entries.length;
			const toolCallId = `source-proof-${index}`;
			await harness.handlers.get("tool_result")[0]({ toolName: "read", toolCallId, isError: false,
				input: { path: file, ...item.input }, content: [{ type: "text", text: item.original }],
			}, ctx);
			await harness.handlers.get("turn_end")[0]({ toolResults: [{ role: "toolResult", toolName: "read", toolCallId,
				isError: false, content: [{ type: "text", text: item.final ?? item.original }],
			}] }, ctx);
			assert.equal(harness.entries.length, before + Number(item.accepted), `source proof ${index}`);
			if (item.accepted) assert.equal(harness.entries.at(-1)[1].tokens, Math.ceil(item.retained!.length / 4));
		}
		writeFileSync(file, `# Skill\n${"X".repeat(1024 * 1024)}`);
		await harness.handlers.get("tool_result")[0]({ toolName: "read", toolCallId: "oversized", isError: false,
			input: { path: file, limit: 1 }, content: [{ type: "text", text: "# Skill" }],
		}, ctx);
		const before = harness.entries.length;
		await harness.handlers.get("turn_end")[0]({ toolResults: [{ role: "toolResult", toolName: "read", toolCallId: "oversized",
			isError: false, content: [{ type: "text", text: "# Skill" }],
		}] }, ctx);
		assert.equal(harness.entries.length, before, "oversized filesystem evidence stays conservatively unmarked");
	});

	it("emits a non-LLM report entry in RPC mode and preserves unknown context usage", async () => {
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => []);
		harness.pi.getAllTools.mockReturnValue([]);
		harness.pi.getActiveTools.mockReturnValue([]);
		contextModule.default(harness.pi);
		const command = harness.commands.get("context");
		const custom = createMockFunction(async () => assert.fail("RPC mode must not open TUI custom UI"));
		const ctx = createMockContext({
			mode: "rpc",
			hasUI: true,
			cwd: "/workspace",
			sessionManager: { buildContextEntries: createMockFunction(() => []) },
			entries: [{ type: "message", message: { role: "assistant", usage: usage(100, 20, 0, 0, 0.12) } }],
			ui: { custom },
			context: {
				getSystemPrompt: createMockFunction(() => "system prompt"),
				getSystemPromptOptions: createMockFunction(() => ({
					cwd: "/workspace",
					selectedTools: [],
					contextFiles: [{ path: "/workspace/AGENTS.override.md", content: "rules" }],
					skills: [],
				})),
				getContextUsage: createMockFunction(() => ({ tokens: null, contextWindow: 200_000, percent: null })),
			},
		});

		await command.handler("", ctx);

		assert.equal(custom.calls.length, 0);
		assert.equal(harness.sentMessages.length, 0);
		assert.equal(harness.entries.length, 1);
		assert.equal(harness.entries[0][0], "context:report");
		assert.match(harness.entries[0][1].content, /Window: \(unknown\)/);
		assert.match(harness.entries[0][1].content, /AGENTS: \.\/AGENTS\.override\.md/);
		assert.match(harness.entries[0][1].content, /Session: 120 tokens · \$0\.120/);
	});

	it("removes terminal and bidirectional controls from displayed metadata", () => {
		assert.equal(contextModule.__test.sanitizeDisplayText("safe\x1b[2J\u202eevil"), "safe [2Jevil");
	});

	it("observes rewritten declarations, not registry descriptions, and rejects unknown payloads", () => {
		const declarations = contextModule.__test.observeDeclarations({ model: "test", messages: [], tools: [
			{ type: "function", function: { name: "codemode", description: "rewritten", parameters: { type: "object" } } },
		] });
		assert.deepEqual([...declarations!.keys()], ["codemode"]);
		assert.equal(contextModule.__test.observeDeclarations({ tools: [] }), null);
		assert.equal(contextModule.__test.observeDeclarations({ model: "test", messages: [], tools: [{ type: "web_search" }] }), null);
		const harness = createMockPi();
		harness.pi.getActiveTools.mockReturnValue(["read", "codemode", "ask"]);
		harness.pi.getAllTools.mockReturnValue([
			{ name: "read", exposure: "direct" },
			{ name: "codemode", exposure: "model-only" },
			{ name: "ask", exposure: "model-only" },
			{ name: "lazy", exposure: "codemode", namespace: { name: "ns\x1b\u202e" } },
			{ name: "deferred", exposure: "deferred" },
			{ name: "hidden", exposure: "hidden" },
		]);
		const rows = contextModule.__test.buildToolInventory(harness.pi, declarations);
		assert.deepEqual(rows.map((row) => [row.name, row.declared, row.callable]), [
			["read", false, true], ["codemode", true, false], ["ask", false, false],
			["lazy", false, true], ["deferred", false, true], ["hidden", false, false],
		]);
		assert.equal(rows[3].namespace, "ns");
		assert.ok(contextModule.__test.buildToolInventory(harness.pi, null).every((row) => row.declared === null));
	});

	it("isolates nested evidence by parent and discards it at lifecycle boundaries", async () => {
		const root = join(tmpdir(), `context-nested-${process.pid}`);
		sandboxes.push(root);
		mkdirSync(root, { recursive: true });
		const file = join(root, "SKILL.md");
		const full = "# Unique complete skill\nTail\n";
		writeFileSync(file, full);
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => [{ name: "skill:demo", source: "skill", sourceInfo: { path: file } }]);
		contextModule.default(harness.pi);
		const ctx = createMockContext({ cwd: root });
		const nested = async (parent: string, text = full) => {
			await harness.handlers.get("tool_result")[0]({
				toolName: "read", toolCallId: `${parent}/1`, parentToolCallId: parent, isError: false,
				input: { path: file }, content: [{ type: "text", text }],
			}, ctx);
			await harness.handlers.get("tool_execution_end")[0]({
				toolName: "read", toolCallId: `${parent}/1`, parentToolCallId: parent, isError: false,
				result: { content: [{ type: "text", text }] },
			}, ctx);
		};
		const result = (parent: string, text: string, isError = false) => ({
			role: "toolResult", toolName: "codemode", toolCallId: parent, isError, content: [{ type: "text", text }],
		});
		const finish = (parent: string, text: string, isError = false) => harness.handlers.get("turn_end")[0]({
			toolResults: [result(parent, text, isError)],
		}, ctx);
		await nested("discard");
		await finish("unrelated", full);
		await finish("discard", "discarded");
		await nested("partial-read", "# Unique");
		await finish("partial-read", full);
		await nested("partial-output");
		await finish("partial-output", "# Unique");
		await nested("failed");
		await finish("failed", full, true);
		await nested("branch");
		await harness.handlers.get("session_tree")[0]({}, ctx);
		await finish("branch", full);
		assert.equal(harness.entries.length, 0);
		await Promise.all([nested("one"), nested("two")]);
		await harness.handlers.get("turn_end")[0]({ toolResults: [result("two", full), result("one", "discarded")] }, ctx);
		assert.equal(harness.entries.length, 1);
		const racing = nested("during-reset");
		await harness.handlers.get("session_start")[0]({}, ctx);
		await racing;
		await finish("during-reset", full);
		assert.equal(harness.entries.length, 1, "an async read cannot recreate evidence after a reset");
		for (let i = 0; i < 65; i++) await nested(`bounded-${i}`);
		await harness.handlers.get("turn_end")[0]({ toolResults: [result("bounded-64", full), result("bounded-0", full)] }, ctx);
		assert.equal(harness.entries.length, 2, "only retained evidence counts; overflow is conservatively dropped");
		await harness.handlers.get("agent_end")[0]({}, ctx);
		await finish("bounded-1", full);
		assert.equal(harness.entries.length, 2, "turn-end releases pending evidence");
	});

	it("keeps TUI summary/details and close controls while labeling estimates and inventory", async () => {
		const harness = createMockPi();
		harness.pi.getCommands = createMockFunction(() => []);
		harness.pi.getActiveTools.mockReturnValue(["read"]);
		harness.pi.getAllTools.mockReturnValue([{ name: "read", exposure: "direct", sourceInfo: { source: "builtin" } }]);
		contextModule.default(harness.pi);
		let closed = false;
		const ctx = createMockContext({
			sessionManager: { buildContextEntries: createMockFunction(() => []) },
			context: {
				getSystemPromptOptions: () => ({ selectedTools: ["read"], contextFiles: [], skills: [] }),
				getSystemPrompt: () => "system",
				getContextUsage: () => ({ tokens: 500, contextWindow: 200000, percent: 0.25 }),
			},
			ui: { custom: async (factory: any) => {
				const view = factory({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => { closed = true; });
				assert.match(view.render(120).join("\n"), /Window: ~500 \/ 200,000/);
				assert.match(view.render(120).join("\n"), /rough, non-additive/);
				view.handleInput("tab");
				const detail = view.render(120).join("\n");
				assert.match(detail, /Skills \(0\)/);
				assert.match(detail, /read: active=yes, declared=\?, callable=yes, hidden=\?/);
				view.handleInput("q");
			} },
		});
		await harness.commands.get("context").handler("", ctx);
		assert.equal(closed, true);
		assert.equal(harness.entries.length, 0);
	});
});
