import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stubModules = new Map([
	["@earendil-works/pi-ai", `
		export function StringEnum(values) { return { enum: values }; }
		export function contentText(content, separator = "\\n") {
			if (typeof content === "string") return content;
			return (content ?? [])
				.filter((block) => block && block.type === "text")
				.map((block) => block.text)
				.join(separator);
		}
		// Minimal Pi-native thinking helpers used by models.ts.
		const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		export function getSupportedThinkingLevels(model) {
			if (!model?.reasoning) return ["off"];
			return LEVELS.filter((level) => {
				const mapped = model.thinkingLevelMap?.[level];
				if (mapped === null) return false;
				if (level === "xhigh" || level === "max") return mapped !== undefined;
				return true;
			});
		}
		export function clampThinkingLevel(model, level) {
			const available = getSupportedThinkingLevels(model);
			if (available.includes(level)) return level;
			const requestedIndex = LEVELS.indexOf(level);
			if (requestedIndex === -1) return available[0] ?? "off";
			for (let i = requestedIndex; i < LEVELS.length; i++) {
				if (available.includes(LEVELS[i])) return LEVELS[i];
			}
			for (let i = requestedIndex - 1; i >= 0; i--) {
				if (available.includes(LEVELS[i])) return LEVELS[i];
			}
			return available[0] ?? "off";
		}
	`],
	["@earendil-works/pi-tui", `
		export class Text {
			constructor(value) { this.value = value; }
			setText(value) { this.value = value; }
			render(width = 120) {
				return String(this.value).split(/\\r?\\n/).map((line) => line.length > width ? line.slice(0, width) : line);
			}
			invalidate() {}
		}
		export class Box {
			constructor(px = 1, py = 0, bgFn = (s) => s) {
				this.px = px; this.py = py; this.bgFn = bgFn; this.children = [];
			}
			addChild(child) { this.children.push(child); }
			render(width = 120) {
				const inner = Math.max(1, width - this.px * 2);
				const rows = [];
				for (const child of this.children) {
					for (const line of child.render(inner)) {
						rows.push(this.bgFn(" ".repeat(this.px) + line + " ".repeat(this.px)));
					}
				}
				return rows;
			}
			invalidate() { for (const c of this.children) c.invalidate?.(); }
		}
		export function visibleWidth(value) { return String(value).length; }
		export function truncateToWidth(value, width, marker = "…") {
			const text = String(value);
			return text.length <= width ? text : text.slice(0, Math.max(0, width - marker.length)) + marker;
		}
		export function wrapTextWithAnsi(value, width) {
			const text = String(value);
			if (text.length === 0) return [""];
			const rows = [];
			for (let index = 0; index < text.length; index += Math.max(1, width)) rows.push(text.slice(index, index + Math.max(1, width)));
			return rows;
		}
	`],
	["@earendil-works/pi-coding-agent", `
		import { join } from "node:path";
		import { homedir } from "node:os";
		export const CONFIG_DIR_NAME = ".pi";
		export function getAgentDir() {
			const envDir = process.env.PI_CODING_AGENT_DIR;
			if (envDir) return envDir;
			return join(homedir(), CONFIG_DIR_NAME, "agent");
		}
	`],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (stubModules.has(specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("stub:")) return { format: "module", source: stubModules.get(url.slice("stub:".length)), shortCircuit: true };
		return nextLoad(url, context);
	},
});

const {
	default: webSearch,
	renderWebSearchToolResult,
	webSearchCallPresentation,
	webSearchResultPresentation,
} = await import("./web-search.ts");
const {
	createSearchRenderers,
	xSearchCallPresentation,
	xSearchResultPresentation,
} = await import("./presentation.ts");

const theme = {
	bg(_name, value) {
		return value;
	},
	fg(_name, value) {
		return value;
	},
	bold(value) {
		return value;
	},
};

function render(component, width = 120) {
	return component.render(width).map((line) => line.trimEnd()).join("\n");
}

const successResult = {
	content: [{ type: "text", text: "Answer text\n\nSources:\n[1] Docs\nhttps://docs.example" }],
	details: {
		ok: true,
		sourceCount: 1,
		provider: "openai",
		model: "gpt-5.4-mini",
		api: "responses",
		elapsedMs: 1234,
		timeoutMs: 60000,
	},
};

test("web search maps owner semantics to Better TUI Protocol v1", () => {
	assert.deepEqual(webSearchCallPresentation({ query: "release notes", limit: 5, allowed_domains: ["example.com"] }), {
		action: "Search",
		target: "release notes",
		metadata: ["limit 5", "1 domain"],
	});
	assert.deepEqual(webSearchResultPresentation(successResult, false, false), {
		status: "success",
		outcome: "1 source",
		metadata: ["1.2s"],
		body: [{ kind: "text", text: "Answer text", strategy: "head-tail" }],
	});
	assert.deepEqual(webSearchResultPresentation({ details: { elapsedMs: 2300 } }, true, false), {
		status: "running",
		outcome: "searching",
		metadata: ["2.3s"],
	});
	assert.deepEqual(webSearchResultPresentation({ isError: true, details: { ok: false, code: "backend_error", status: 502, error: "unavailable" } }, false, true), {
		status: "error",
		outcome: "backend_error",
		metadata: ["HTTP 502"],
		error: "unavailable",
	});
});

test("web search partial renderer uses a compact accent progress line", () => {
	const output = render(renderWebSearchToolResult({ details: { phase: "Searching web...", startedAt: Date.now() - 1200 } }, false, true, theme));

	assert.match(output, /Searching web\.\.\./);
	assert.match(output, /1\.2s|1s/);
	assert.doesNotMatch(output, /Web Search/);
	assert.doesNotMatch(output, /^\n\n/);
});

test("web search partial renderer recomputes elapsed while rendering", (t) => {
	const originalNow = Date.now;
	let now = 1000;
	Date.now = () => now;
	t.after(() => {
		Date.now = originalNow;
	});

	const component = renderWebSearchToolResult({ details: { phase: "Searching web...", startedAt: 0 } }, false, true, theme);

	assert.match(render(component), /1\.0s/);
	now = 2500;
	assert.match(render(component), /2\.5s/);
});

function assertWidthSafe(component, widths = [1, 2, 18, 36]) {
	// Stub visibleWidth treats ANSI as zero-width-free; use string length on stubbed Text.
	for (const width of widths) {
		const lines = component.render(width);
		assert.ok(lines.length > 0, `width ${width} returns rows`);
		for (const line of lines) {
			// strip simple CSI sequences if present, then measure.
			const plain = String(line).replace(/\u001b\[[0-9;]*m/g, "");
			assert.ok(plain.length <= width, `expected ${JSON.stringify(line)} to fit width ${width}`);
		}
	}
}

test("web search partial renderer respects narrow widths", () => {
	const phase = "Searching the public web for current release notes that are intentionally long";
	const component = renderWebSearchToolResult({ details: { phase, startedAt: Date.now() - 2500 } }, false, true, theme);
	assertWidthSafe(component);
});

test("web search call/partial/collapsed/expanded all fit Pi width contract", () => {
	const renderers = createSearchRenderers("web");
	assertWidthSafe(renderers.renderCall({ query: "What is the latest stable Node.js release and why does it matter for production?" }, theme, {}));
	assertWidthSafe(renderers.renderResult({ details: { phase: "Searching web for a very long query string", startedAt: Date.now() - 1200 } }, { expanded: false, isPartial: true }, theme, {}));
	assertWidthSafe(renderers.renderResult(successResult, { expanded: false, isPartial: false }, theme, {}));
	assertWidthSafe(renderers.renderResult(successResult, { expanded: true, isPartial: false }, theme, {}));
});

test("search and x search fallback calls share terminal background and footer layout", () => {
	const markedTheme = {
		...theme,
		bg: (name, value) => `<${name}>${value}</${name}>`,
	};
	for (const kind of ["web", "x"]) {
		const renderers = createSearchRenderers(kind);
		const state = { codexToolsBetterTuiV1: { family: "fallback" } };
		const context = { state, invalidate() {} };
		const call = renderers.renderCall({ query: "current release notes" }, markedTheme, context);
		assert.match(call.render(500).join("\n"), /toolPendingBg/);
		const result = renderers.renderResult(successResult, { expanded: false, isPartial: false }, markedTheme, context);
		const completedCall = call.render(500).join("\n");
		assert.match(completedCall, /toolSuccessBg/);
		assert.doesNotMatch(completedCall, /toolPendingBg/);
		assert.match(result.render(500).at(-2), /Took 1\.2s.*1 source/);
	}
});

test("web search expanded long single-line error is hard-bounded", () => {
	const longError = `backend unavailable ${"x".repeat(5_000)}`;
	const component = renderWebSearchToolResult({
		isError: true,
		content: [{ type: "text", text: longError }],
		details: { ok: false, code: "backend_error", status: 502, error: longError, elapsedMs: 980 },
	}, true, false, theme);
	const joined = render(component, 36);
	assert.match(joined, /backend_error|failed|HTTP 502|1\.0s|980/);
	assert.ok(!joined.includes("x".repeat(300)), "expanded error must not dump unbounded single-line detail");
	assertWidthSafe(component);
});

test("web search collapsed success shows sources, timing, and answer preview", () => {
	const output = render(renderWebSearchToolResult(successResult, false, false, theme));

	assert.match(output, /1 source/);
	assert.match(output, /1\.2s/);
	assert.match(output, /Answer text/);
	assert.match(output.split("\n").at(-2), /Took 1\.2s.*1 source/, "source/timing summary precedes bottom padding");
	assert.doesNotMatch(output, /Web Search/);
	assert.doesNotMatch(output, /openai\/gpt-5\.4-mini/);
	assert.doesNotMatch(output, /Sources:/);
});

test("web search expanded success renders answer details", () => {
	const output = render(renderWebSearchToolResult(successResult, true, false, theme));

	assert.match(output, /1 source/);
	assert.match(output, /Answer text/);
	assert.match(output.split("\n").at(-2), /Took 1\.2s.*1 source/, "expanded summary stays below the body");
	assert.doesNotMatch(output, /Web Search/);
	assert.doesNotMatch(output, /Sources:/);
	assert.doesNotMatch(output, /https:\/\/docs\.example/);
});

test("web search expanded long answer stays multi-line without full-width padding artifacts", () => {
	const width = 36;
	const long = "This is a deliberately long answer line that must remain readable without becoming one giant clipped summary row for the TUI.";
	const lines = renderWebSearchToolResult({
		...successResult,
		content: [{ type: "text", text: long + "\n\nSources:\n[1] Docs\nhttps://docs.example" }],
	}, true, false, theme).render(width);

	assert.ok(lines.length >= 2, "expanded output has multiple rows");
	// Native shell uses Box padding; lines should not be force-padded to terminal width with trailing spaces only.
	const joined = lines.join("\n");
	assert.match(joined, /1 source|1\.2s/);
	assert.doesNotMatch(joined, /https:\/\/docs\.example/);
});

test("web search expanded strips source-only lines from backend answers", () => {
	const output = render(renderWebSearchToolResult({
		...successResult,
		content: [{ type: "text", text: "1. **全球关注**\n- 美国进入假期。\n来源：GPB、Euronews\n- https://www.gpb.org/news/item\n- https://www.euronews.com/just-in\n\n2. **中东局势**\n- Reuters 相关报道显示风险仍在。\n\nSources:\n[1] Docs\nhttps://docs.example" }],
	}, true, false, theme));

	assert.match(output, /全球关注/);
	assert.match(output, /中东局势/);
	assert.doesNotMatch(output, /来源/);
	assert.doesNotMatch(output, /https:\/\//);
});

test("web search error renderer surfaces failure status and error details", () => {
	const output = render(renderWebSearchToolResult({
		isError: true,
		content: [{ type: "text", text: "Error: backend unavailable" }],
		details: {
			ok: false,
			code: "backend_error",
			status: 502,
			error: "backend unavailable",
			provider: "openai",
			model: "gpt-5.4-mini",
			elapsedMs: 980,
		},
	}, true, false, theme));

	assert.match(output, /backend_error/);
	assert.match(output, /backend unavailable/);
	assert.match(output, /HTTP 502|502/);
});

test("x search maps owner semantics to Better TUI Protocol v1", () => {
	assert.deepEqual(xSearchCallPresentation({ query: "pi release" }), {
		action: "X Search",
		target: "pi release",
	});
	assert.deepEqual(xSearchResultPresentation(successResult, false, false), {
		status: "success",
		outcome: "1 source",
		metadata: ["1.2s"],
		body: [{ kind: "text", text: "Answer text", strategy: "head-tail" }],
	});
	assert.deepEqual(xSearchResultPresentation({ details: { elapsedMs: 2300 } }, true, false), {
		status: "running",
		outcome: "searching X",
		metadata: ["2.3s"],
	});
});

function registeredWebSearchTool() {
	let tool;
	webSearch({
		on() {},
		registerTool(definition) {
			tool = definition;
		},
	});
	assert.ok(tool, "web_search tool was registered");
	assert.equal(Object.hasOwn(tool.parameters.properties, "recency"), false, "unsupported recency must not be exposed by the public schema");
	return tool;
}

test("web_search rejects when no source is configured", async () => {
	const root = mkdtempSync(join(tmpdir(), "web-access-web-search-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}\n");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const tool = registeredWebSearchTool();
		await assert.rejects(
			() => tool.execute("call-missing-config", { query: "latest Pi release", provider: "openai" }, undefined, undefined, {
				cwd,
				isProjectTrusted: () => true,
				modelRegistry: { find: () => undefined },
			}),
			/No openai web search source is configured/i,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

function captureRequestHeaders(init) {
	const headers = new Headers(init?.headers);
	return {
		has(name) { return headers.has(name); },
		get(name) { return headers.get(name); },
		values() { return [...headers.values()]; },
	};
}

async function withConfiguredWebSearch(auth, fetchImpl, callback) {
	const root = mkdtempSync(join(tmpdir(), "web-access-web-search-headers-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}\n");
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
		webAccess: { openai: { model: "test/text-model" } },
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	globalThis.fetch = fetchImpl;
	try {
		const tool = registeredWebSearchTool();
		const modelRegistry = {
			find(provider, id) {
				if (provider !== "test" || id !== "text-model") return undefined;
				return { provider, id, baseUrl: "https://search.example.test/v1", api: "openai-responses" };
			},
			async getApiKeyAndHeaders() {
				return auth;
			},
		};
		return await callback(tool, {
			cwd,
			isProjectTrusted: () => true,
			modelRegistry,
		});
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}

test("web_search outbound fetch drops ProviderHeaders null deletion markers and keeps gateway headers", async () => {
	let captured;
	await withConfiguredWebSearch(
		{
			ok: true,
			apiKey: "fallback-key",
			headers: {
				Authorization: null,
				"x-api-key": null,
				"cf-aig-authorization": "Bearer gateway-token",
				"X-Test": "kept",
			},
		},
		async (_input, init) => {
			captured = captureRequestHeaders(init);
			return new Response(JSON.stringify({
				id: "resp_headers",
				model: "text-model",
				output: [{ type: "output_text", text: "ok", annotations: [], sources: [] }],
			}), { headers: { "content-type": "application/json" } });
		},
		async (tool, ctx) => {
			const result = await tool.execute("call-null-headers", { query: "latest Pi release", provider: "openai" }, undefined, undefined, ctx);
			assert.equal(result.details.ok, true);
			assert.ok(captured, "web_search must issue an outbound fetch");
			assert.equal(captured.has("Authorization"), false);
			assert.equal(captured.has("x-api-key"), false);
			assert.equal(captured.get("cf-aig-authorization"), "Bearer gateway-token");
			assert.equal(captured.get("X-Test"), "kept");
			assert.equal(captured.values().includes("null"), false);
		},
	);
});

test("web_search outbound fetch adds Authorization Bearer when headers are empty", async () => {
	let captured;
	await withConfiguredWebSearch(
		{ ok: true, apiKey: "fallback-key", headers: {} },
		async (_input, init) => {
			captured = captureRequestHeaders(init);
			return new Response(JSON.stringify({
				id: "resp_bearer",
				model: "text-model",
				output: [{ type: "output_text", text: "ok", annotations: [], sources: [] }],
			}), { headers: { "content-type": "application/json" } });
		},
		async (tool, ctx) => {
			const result = await tool.execute("call-bearer", { query: "latest Pi release", provider: "openai" }, undefined, undefined, ctx);
			assert.equal(result.details.ok, true);
			assert.ok(captured, "web_search must issue an outbound fetch");
			assert.equal(captured.get("Authorization"), "Bearer fallback-key");
		},
	);
});



test("web search collapsed long answer preview stays bounded at narrow width", () => {
	const longAnswer = "A".repeat(400) + " meaningful answer continues with details about markets and policy.";
	const component = renderWebSearchToolResult({
		content: [{ type: "text", text: longAnswer + "\n\nSources:\n[1] Docs\nhttps://docs.example" }],
		details: { ok: true, sourceCount: 3, elapsedMs: 2400 },
	}, false, false, theme);
	const width = 40;
	const lines = component.render(width);
	assert.ok(lines.length >= 2, "status + preview");
	const joined = lines.join("\n");
	assert.match(joined, /3 sources|2\.4s/);
	// Preview is bounded; must not dump the entire 400+ char answer on one unclipped status row.
	assert.ok(!joined.includes("A".repeat(200)), "must not dump entire long answer in collapsed view");
});

test("web search result renderer invalidates while partial elapsed is visible", async (t) => {
	const tool = registeredWebSearchTool();
	assert.equal(tool.renderShell, "self");
	const state = {};
	let invalidations = 0;
	const context = {
		isError: false,
		state,
		invalidate() {
			invalidations++;
		},
	};
	const stopTimer = () => tool.renderResult(successResult, { expanded: false, isPartial: false }, theme, context);
	t.after(stopTimer);

	tool.renderResult({ details: { phase: "Searching web...", startedAt: Date.now() } }, { expanded: false, isPartial: true }, theme, context);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.ok(invalidations >= 1, "partial renderer should request periodic re-rendering");

	stopTimer();
	const invalidationsAfterStop = invalidations;
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(invalidations, invalidationsAfterStop, "final renderer should clear the elapsed timer");
});

test("native web search render strips OSC52/OSC title/CSI from untrusted answer and error surfaces", () => {
	const payload = "Answer\x1b]52;c;SGk=\x07 mid\x1b]0;pwned\x07 end\x1b[2J";
	const success = render(renderWebSearchToolResult({
		content: [{ type: "text", text: `${payload}\n\nSources:\n[1] Docs\nhttps://docs.example` }],
		details: { ok: true, sourceCount: 1, elapsedMs: 1000 },
	}, true, false, theme));
	assert.match(success, /Answer/);
	assert.doesNotMatch(success, /\x1b|\x07|pwned|52;c/);

	const errorOut = render(renderWebSearchToolResult({
		isError: true,
		content: [{ type: "text", text: payload }],
		details: { ok: false, code: "backend_error", error: payload, elapsedMs: 500 },
	}, true, false, theme));
	assert.doesNotMatch(errorOut, /\x1b|\x07|pwned|52;c/);

	const call = createSearchRenderers("web").renderCall({
		query: `release\x1b]0;title\x07notes`,
	}, theme, {});
	assert.doesNotMatch(call.render(80).join("\n"), /\x1b|\x07/);
});

test("retrieval search keeps excerpts in model text and native/Better TUI presentation", () => {
	const retrieval = {
		content: [{
			type: "text",
			text: "Sources:\n[1] Page\nhttps://docs.example/page\nexcerpt from hosted search\n[2] Other\nhttps://docs.example/other\nsecond excerpt",
		}],
		details: { ok: true, sourceCount: 2, elapsedMs: 800, source: "exa" },
	};
	assert.match(retrieval.content[0].text, /excerpt from hosted search/);

	const better = webSearchResultPresentation(retrieval, false, false);
	assert.equal(better.status, "success");
	assert.equal(better.outcome, "2 sources");
	assert.ok(better.body?.[0]?.text.includes("Page"));
	assert.ok(better.body?.[0]?.text.includes("https://docs.example/page"));
	assert.ok(better.body?.[0]?.text.includes("excerpt from hosted search"));

	const collapsed = render(renderWebSearchToolResult(retrieval, false, false, theme));
	assert.match(collapsed, /Page|excerpt/);
	assert.match(collapsed, /2 sources/);
	const expanded = render(renderWebSearchToolResult(retrieval, true, false, theme));
	assert.match(expanded, /https:\/\/docs\.example\/page/);
	assert.match(expanded, /excerpt from hosted search/);
	assert.match(expanded, /second excerpt/);
});

test("answering-source presentation still strips Sources and keeps the answer body", () => {
	const presented = webSearchResultPresentation(successResult, false, false);
	assert.deepEqual(presented.body, [{ kind: "text", text: "Answer text", strategy: "head-tail" }]);
	const expanded = render(renderWebSearchToolResult(successResult, true, false, theme));
	assert.match(expanded, /Answer text/);
	assert.doesNotMatch(expanded, /Sources:/);
	assert.doesNotMatch(expanded, /https:\/\/docs\.example/);
});
