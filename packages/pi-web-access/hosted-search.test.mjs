import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXA_SEARCH_URL, FIRECRAWL_SEARCH_URL } from "./hosted-http.ts";
import webSearch from "./web-search.ts";
import { webSearchResultPresentation, renderWebSearchToolResult } from "./presentation.ts";

function registeredWebSearch() {
	let tool;
	webSearch({
		on() {},
		registerTool(definition) {
			if (definition.name === "web_search") tool = definition;
		},
	});
	assert.ok(tool);
	return tool;
}

async function withAgentDir(callback) {
	const root = mkdtempSync(join(tmpdir(), "web-access-hosted-search-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ webAccess: {} }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	const previousExa = process.env.EXA_API_KEY;
	const previousFirecrawl = process.env.FIRECRAWL_API_KEY;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.EXA_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
	try {
		return await callback({
			setFetch(fetchImpl) {
				globalThis.fetch = fetchImpl;
			},
			env: process.env,
			modelRegistry: {
				find() { return undefined; },
				async getApiKeyAndHeaders() { return { ok: false }; },
			},
		});
	} finally {
		globalThis.fetch = previousFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousExa === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = previousExa;
		if (previousFirecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
		else process.env.FIRECRAWL_API_KEY = previousFirecrawl;
		rmSync(root, { recursive: true, force: true });
	}
}

test("explicit firecrawl search works without an API key", async () => {
	await withAgentDir(async (ctx) => {
		const bodies = [];
		ctx.setFetch(async (input, init) => {
			assert.equal(String(input), FIRECRAWL_SEARCH_URL);
			bodies.push(JSON.parse(String(init.body)));
			assert.equal(init.headers.Authorization, undefined);
			return new Response(JSON.stringify({
				success: true,
				data: { web: [{ url: "https://docs.example", title: "Docs", description: "snippet", position: 1 }] },
			}));
		});
		const result = await registeredWebSearch().execute("call-fc", { query: "latest Pi", provider: "firecrawl", limit: 3 }, undefined, undefined, ctx);
		assert.equal(result.details.source, "firecrawl");
		assert.equal(result.details.ok, true);
		assert.equal(bodies[0].limit, 3);
		assert.match(result.content[0].text, /https:\/\/docs\.example/);
		assert.match(result.content[0].text, /snippet/);
		assert.match(result.content[0].text, /Docs/);
	});
});

test("Exa multi-highlight excerpts survive tool output and both presentation paths", async () => {
	await withAgentDir(async (ctx) => {
		process.env.EXA_API_KEY = "exa-secret";
		const highlights = ["First excerpt", "[2] quoted paragraph", "More evidence"];
		ctx.setFetch(async () => new Response(JSON.stringify({
			results: [
				{ url: "https://docs.example/page", title: "First page", highlights },
				{ url: "https://docs.example/next", title: "Next page", highlights: ["Second excerpt"] },
			],
		})));
		const result = await registeredWebSearch().execute("multi-highlight", {
			query: "docs", provider: "exa",
		}, undefined, undefined, ctx);
		const theme = { fg: (_key, text) => text, bg: (_key, text) => text, bold: (text) => text };
		const betterBody = webSearchResultPresentation(result, false, false).body;
		assert.ok(betterBody?.length);
		const betterText = betterBody.map((item) => item.text).join("\n");
		const nativeText = renderWebSearchToolResult(result, true, false, theme).render(100).join("\n");
		for (const text of [result.content[0].text, betterText, nativeText]) {
			for (const expected of [...highlights, "Next page", "Second excerpt", "https://docs.example/page", "https://docs.example/next"]) {
				assert.ok(text.includes(expected), `missing ${expected}`);
			}
		}
	});
});

test("explicit exa search requires EXA_API_KEY", async () => {
	await withAgentDir(async (ctx) => {
		await assert.rejects(
			() => registeredWebSearch().execute("call-exa-missing", { query: "latest Pi", provider: "exa" }, undefined, undefined, ctx),
			/EXA_API_KEY/,
		);
	});
});

test("explicit exa search sends highlights and the API key", async () => {
	await withAgentDir(async (ctx) => {
		process.env.EXA_API_KEY = "exa-secret";
		ctx.env = process.env;
		ctx.setFetch(async (input, init) => {
			assert.equal(String(input), EXA_SEARCH_URL);
			assert.equal(init.headers.Authorization, "Bearer exa-secret");
			const body = JSON.parse(String(init.body));
			assert.equal(body.contents.highlights, true);
			assert.deepEqual(body.includeDomains, ["docs.example"]);
			return new Response(JSON.stringify({
				results: [{ url: "https://docs.example/page", title: "Page", highlights: ["excerpt"] }],
			}));
		});
		const result = await registeredWebSearch().execute("call-exa", {
			query: "latest Pi",
			provider: "exa",
			allowed_domains: ["docs.example"],
		}, undefined, undefined, ctx);
		assert.equal(result.details.source, "exa");
		assert.match(result.content[0].text, /https:\/\/docs\.example\/page/);
		assert.match(result.content[0].text, /excerpt/);
		assert.match(result.content[0].text, /Page/);
	});
});
