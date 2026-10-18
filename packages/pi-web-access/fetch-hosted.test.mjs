import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fetchContent from "./fetch-content.ts";
import { EXA_CONTENTS_URL, FIRECRAWL_SCRAPE_URL } from "./hosted-http.ts";

function registeredFetch() {
	let tool;
	fetchContent({
		on() {},
		registerTool(definition) {
			if (definition.name === "fetch_content") tool = definition;
		},
	});
	assert.ok(tool);
	return tool;
}

async function withAgentDir(callback) {
	const root = mkdtempSync(join(tmpdir(), "web-access-fetch-hosted-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ webAccess: {} }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	const previousExa = process.env.EXA_API_KEY;
	const previousCdp = process.env.CDP_ENDPOINT;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.EXA_API_KEY;
	delete process.env.CDP_ENDPOINT;
	try {
		return await callback({
			setFetch(fetchImpl) {
				globalThis.fetch = fetchImpl;
			},
			env: process.env,
			cwd: root,
			isProjectTrusted: () => false,
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
		if (previousCdp === undefined) delete process.env.CDP_ENDPOINT;
		else process.env.CDP_ENDPOINT = previousCdp;
		rmSync(root, { recursive: true, force: true });
	}
}

test("default fetch does not fall back to Firecrawl when CDP is missing", async () => {
	await withAgentDir(async (ctx) => {
		await assert.rejects(
			() => registeredFetch().execute("call-cdp", { url: "https://example.com" }, undefined, undefined, ctx),
			/CDP_ENDPOINT or webAccess\.fetch\.cdp\.endpoint/,
		);
	});
});

test("firecrawl fetch works without CDP and does not use a kernel", async () => {
	await withAgentDir(async (ctx) => {
		ctx.setFetch(async (input, init) => {
			assert.equal(String(input), FIRECRAWL_SCRAPE_URL);
			assert.equal(init.headers.Authorization, undefined);
			const body = JSON.parse(String(init.body));
			assert.equal(body.url, "https://example.com/article");
			assert.deepEqual(body.formats, ["markdown"]);
			return new Response(JSON.stringify({
				success: true,
				data: {
					markdown: "# Hello\n\nWorld",
					metadata: { title: "Hello", sourceURL: "https://example.com/article" },
				},
			}));
		});
		const result = await registeredFetch().execute("call-fc", {
			url: "https://example.com/article",
			provider: "firecrawl",
			kernel: "defuddle",
		}, undefined, undefined, ctx);
		assert.equal(result.details.source, "firecrawl");
		assert.equal(Object.hasOwn(result.details, "kernel"), false);
		assert.equal(result.details.title, "Hello");
		assert.match(result.content[0].text, /# Hello/);
	});
});

test("exa fetch requires EXA_API_KEY and returns contents text", async () => {
	await withAgentDir(async (ctx) => {
		await assert.rejects(
			() => registeredFetch().execute("call-exa-missing", { url: "https://example.com", provider: "exa" }, undefined, undefined, ctx),
			/EXA_API_KEY/,
		);
		process.env.EXA_API_KEY = "exa-secret";
		ctx.env = process.env;
		ctx.setFetch(async (input, init) => {
			assert.equal(String(input), EXA_CONTENTS_URL);
			assert.equal(init.headers.Authorization, "Bearer exa-secret");
			return new Response(JSON.stringify({
				results: [{ url: "https://example.com", title: "Example", text: "page text" }],
			}));
		});
		const result = await registeredFetch().execute("call-exa", { url: "https://example.com", provider: "exa" }, undefined, undefined, ctx);
		assert.equal(result.details.source, "exa");
		assert.match(result.content[0].text, /page text/);
	});
});
