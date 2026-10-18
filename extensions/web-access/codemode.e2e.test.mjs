import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { discoverHost, hostDependency } from "./host-runtime.mjs";
import { Value } from "typebox/value";
import { FetchOutputSchema, SearchOutputSchema } from "./result-schema.ts";

test("web-access host overrides fail closed without default discovery", () => {
	const root = mkdtempSync(join(tmpdir(), "web-access-host-discovery-"));
	const previous = process.env.PI_WEB_ACCESS_HOST;
	try {
		for (const value of ["", "   ", join(root, "missing"), root]) {
			process.env.PI_WEB_ACCESS_HOST = value;
			assert.throws(discoverHost, /Pi 0\.99\.1, 0\.99\.2, 1\.1\.0, or 1\.3\.0 host not found/);
		}
		process.env.PI_WEB_ACCESS_HOST = root;
		mkdirSync(join(root, "dist"));
		// Invalid metadata fixtures are never imported as SDKs.
		writeFileSync(join(root, "dist/index.js"), "");
		writeFileSync(join(root, "dist/index.d.ts"), "");
		for (const metadata of ["{", JSON.stringify({ name: "wrong-package", version: "0.99.2" }),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.3" }),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.0" })]) {
			writeFileSync(join(root, "package.json"), metadata);
			assert.throws(discoverHost, /Pi 0\.99\.1, 0\.99\.2, 1\.1\.0, or 1\.3\.0 host not found/);
		}
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.2" }));
		rmSync(join(root, "dist/index.js"));
		assert.throws(discoverHost, /Pi 0\.99\.1, 0\.99\.2, 1\.1\.0, or 1\.3\.0 host not found/);
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_ACCESS_HOST; else process.env.PI_WEB_ACCESS_HOST = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi 0.99.1/0.99.2/1.1.0 SDK: native codemode structured web pipeline, spills, errors, permissions, redaction and cancellation", { timeout: 60000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "web-access-native-e2e-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	mkdirSync(agentDir, { mode: 0o700 });
	mkdirSync(cwd, { mode: 0o700 });
	const spillDir = join(root, "spills ' \" $(touch SHOULD_NOT_EXIST) ; 汉");
	mkdirSync(spillDir, { mode: 0o700 });
	const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_PACKAGE_DIR", "CDP_ENDPOINT", "CDP_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY", "TMPDIR"].map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.TMPDIR = spillDir;
	for (const name of ["CDP_ENDPOINT", "CDP_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY"]) delete process.env[name];
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ webAccess: { openai: { model: "fixture-search/search" }, xai: { model: "fixture-search/search" }, fetch: { maxInlineChars: 120 } } }), { mode: 0o600 });
	const originalFetch = globalThis.fetch;
	let session;
	let spill;
	let singleLineSpill;
	try {
		const host = discoverHost();
		console.log(`Actual Pi host ${host.version}: ${host.root}`);
		assert.ok(["0.99.1", "0.99.2", "1.1.0", "1.3.0"].includes(host.version));
		// SDK config reads package metadata/assets from this env, which can be inherited from a different Pi.
		process.env.PI_PACKAGE_DIR = host.root;
		const sdk = await import(pathToFileURL(join(host.root, "dist/index.js")));
		assert.equal(sdk.VERSION, host.version, "loaded SDK matches the selected real package version");
		const ai = await import(pathToFileURL(join(hostDependency(host, "@earendil-works/pi-ai"), "dist/index.js")));
		const plans = [];
		const calls = [];
		const results = [];
		const events = [];
		let deny = false;
		let denyBash = false;
		let redact = false;
		let cancellationObserved = false;
		let notifyRequest;
		const requests = [];
		const singleLineMarkdown = `${"😀".repeat(150000)}完整😀COMPLETE_TAIL`;
		const unit = dirname(fileURLToPath(import.meta.url));
		// Execute the published fallback verbatim, rather than testing a different reader.
		const boundedSpillExample = readFileSync(join(unit, "README.md"), "utf8")
			.match(/```js\n(\/\/ Bounded spill byte ranges[\s\S]*?)\n```/)?.[1];
		assert.ok(boundedSpillExample, "README must contain the bounded native bash fallback");
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			const body = JSON.parse(init.body);
			requests.push({ url, body });
			if (url === "https://fixture.invalid/v1/responses") {
				if (body.input?.[0]?.content?.[0]?.text === "fail") return Response.json({ error: { message: "upstream failed" } }, { status: 503 });
				if (body.input?.[0]?.content?.[0]?.text === "sse") return new Response([
					{ type: "response.output_text.delta", delta: "Stream fixture answer" },
					{ type: "response.output_item.done", item: { id: "ws_item", type: "web_search_call" } },
					{ type: "response.output_item.done", item: { id: "msg_item", type: "message", content: [{ type: "output_text", text: "Stream fixture answer" }] } },
					{ type: "response.completed", response: { id: "resp_actual", model: "search" } },
				].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
				const type = body.tools[0].type;
				return Response.json({ id: "fixture-request", model: "search", output_text: "Fixture answer", output: [{ type: `${type}_call` }], citations: [{ title: "Evidence", url: type === "x_search" ? "https://x.com/fixture/status/1" : "https://example.com/article", cited_text: "Evidence text" }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
			}
			if (url === "https://api.firecrawl.dev/v2/search") {
				if (body.query === "cancel") {
					notifyRequest();
					return await new Promise((_resolve, reject) => {
						const abort = () => { cancellationObserved = true; reject(init.signal.reason); };
						if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, { once: true });
					});
				}
				if (body.query === "fail") return Response.json({ error: "upstream failed" }, { status: 503 });
				return Response.json({ success: true, data: { web: [
					{ title: "Article", url: "https://example.com/article", description: "Evidence" },
					{ title: "Duplicate", url: "https://example.com/article#tail", description: "Evidence" },
					{ title: "Excluded", url: "https://other.example/" },
				] } });
			}
			if (url === "https://api.firecrawl.dev/v2/scrape") {
				const markdown = body.url.endsWith("/single-line") ? singleLineMarkdown
					: body.url.endsWith("/large") ? `${"Large evidence line.\n".repeat(30000)}SPILL_COMPLETE_TAIL` : `${"Evidence line.\n".repeat(100)}COMPLETE_TAIL`;
				return Response.json({ success: true, data: { markdown, metadata: { title: "Fixture page", sourceURL: body.url } } });
			}
			throw new Error(`Unexpected external request: ${url}`);
		};
		const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: ["codemode", "web_search", "x_search", "fetch_content", "read", "bash"] });
		const resourceLoader = new sdk.DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [join(dirname(fileURLToPath(import.meta.url)), "index.ts")],
			extensionFactories: [sdk.createCodemodeExtension({ mode: "on" }), (pi) => {
				pi.registerProvider("fixture-script", {
					api: "web-access-scripted", baseUrl: "https://unused.invalid", apiKey: "fixture-only",
					models: [{ id: "script", name: "Deterministic script", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
					streamSimple(model) {
						assert.ok(plans.length, "No unscripted model call is allowed");
						const plan = plans.shift();
						const message = { role: "assistant", content: plan ? [{ type: "toolCall", id: `call-${Date.now()}`, name: plan.name, arguments: plan.args }] : [{ type: "text", text: "Done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: plan ? "toolUse" : "stop", timestamp: Date.now() };
						const stream = ai.createAssistantMessageEventStream();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: message.stopReason, message });
						stream.end(message);
						return stream;
					},
				});
				pi.registerProvider("fixture-search", { api: "openai-responses", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-only", models: [{ id: "search", name: "Fixture search", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
				pi.on("tool_call", (event) => {
					calls.push(event);
					if (deny && event.toolName === "fetch_content") return { block: true, reason: "Fixture permission denied" };
					if (denyBash && event.toolName === "bash") return { block: true, reason: "Fixture bash permission denied" };
				});
				pi.on("tool_result", (event) => {
					results.push(event);
					if (redact && event.toolName === "web_search") return { content: [{ type: "text", text: "[redacted]" }] };
				});
			}],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "model-store"), refreshOnCreate: false });
		const sessionManager = sdk.SessionManager.create(cwd, join(agentDir, "sessions"));
		({ session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader, modelRuntime, settingsManager, sessionManager, model: { id: "script", name: "Script", provider: "fixture-script", api: "web-access-scripted", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, thinkingLevel: "off" }));
		await session.bindExtensions({});
		session.subscribe((event) => events.push(event));
		async function run(name, args) {
			plans.push({ name, args }, null);
			await session.prompt("Run the deterministic fixture plan.");
			assert.equal(plans.length, 0);
			return session.messages.filter((message) => message.role === "toolResult").at(-1);
		}
		let result = await run("codemode", { code: `const r = await tools.web_search({query: "evidence", provider: "openai"}); text({answer:r.answer, citation:r.citations[0].citedText, source:r.source, request:r.requestId});` });
		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.content), /Fixture answer/);
		assert.match(JSON.stringify(result.content), /Evidence text/);
		assert.match(JSON.stringify(result.content), /fixture-request/);
		assert.equal(Value.Check(SearchOutputSchema, results.filter((event) => event.toolName === "web_search").at(-1).structuredContent), true);
		result = await run("codemode", { code: `const r = await tools.web_search({query:"sse",provider:"openai"}); text({answer:r.answer,requestId:r.requestId});` });
		assert.equal(result.isError, false);
		assert.deepEqual(JSON.parse(result.content.at(-1).text), { answer: "Stream fixture answer", requestId: "resp_actual" });
		result = await run("codemode", { code: `const r = await tools.x_search({query: "fixture"}); text({answer:r.answer,url:r.citationUrls[0]});` });
		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.content), /x.com\/fixture\/status\/1/);
		result = await run("codemode", { code: `const r = await tools.web_search({query: "evidence", provider: "firecrawl"}); const urls = [...new Set(r.sources.map(s => s.url.split("#")[0]))].filter(u => u.startsWith("https://example.com/")); const pages = await Promise.all(urls.map(url => tools.fetch_content({url,provider:"firecrawl"}))); text({count:pages.length,tail:pages[0].markdown.endsWith("COMPLETE_TAIL"),displayTruncated:pages[0].truncated,structuredTruncated:pages[0].structuredTruncated});` });
		assert.equal(result.isError, false);
		assert.equal(JSON.parse(result.content.at(-1).text).tail, true);
		assert.equal(JSON.parse(result.content.at(-1).text).count, 1);
		assert.equal(JSON.parse(result.content.at(-1).text).structuredTruncated, false);
		const fetched = results.filter((event) => event.toolName === "fetch_content").at(-1);
		assert.equal(Value.Check(FetchOutputSchema, fetched.structuredContent), true);
		assert.equal(fetched.structuredContent.markdown.endsWith("COMPLETE_TAIL"), true);
		assert.equal(fetched.content[0].text.includes("COMPLETE_TAIL"), false);
		assert.ok(fetched.structuredContent.retrievedAt);
		assert.ok(result.nestedCalls.calls.some((call) => call.name === "fetch_content" && call.status === "ok"));
		assert.ok(events.some((event) => event.type === "tool_execution_start" && event.parentToolCallId && event.toolName === "fetch_content"));
		result = await run("codemode", { code: `const r = await tools.fetch_content({url:"https://example.com/large",provider:"firecrawl"}); const tail = await tools.read({path:r.fullOutputPath,offset:30001,limit:1}); text({truncated:r.structuredTruncated,inlineChars:r.markdown.length,tail});` });
		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.content), /SPILL_COMPLETE_TAIL/);
		assert.equal(JSON.parse(result.content.at(-1).text).inlineChars, 0);
		spill = results.filter((event) => event.toolName === "fetch_content").at(-1).structuredContent.fullOutputPath;
		assert.equal(statSync(spill).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(spill)).mode & 0o777, 0o700);
		assert.equal(readFileSync(spill, "utf8").endsWith("SPILL_COMPLETE_TAIL"), true);
		assert.ok(session.getActiveToolNames().includes("bash"), "Native bash is explicitly available for the fallback");
		result = await run("codemode", { code: `${boundedSpillExample}
const r = await tools.fetch_content({url:"https://example.com/single-line",provider:"firecrawl"});
const diagnostic = await tools.read({path:r.fullOutputPath,offset:1,limit:1});
const tail = await readSpillBytes(r.fullOutputPath,r.totalBytes-23,23);
const splitCodePoint = await readSpillBytes(r.fullOutputPath,r.totalBytes-22,22);
const bounded = await readSpillBytes(r.fullOutputPath,r.totalBytes-4096,4096);
let invalidRangeRejected = false;
try { await readSpillBytes(r.fullOutputPath,0,4097); } catch(e) { invalidRangeRejected = true; }
text({inlineChars:r.markdown.length,truncated:r.structuredTruncated,diagnostic,tail,splitCodePoint,bounded,invalidRangeRejected});` });
		assert.equal(result.isError, false);
		const singleLineResult = JSON.parse(result.content.at(-1).text);
		assert.equal(singleLineResult.inlineChars, 0);
		assert.equal(singleLineResult.truncated, true);
		assert.match(singleLineResult.diagnostic, /exceeds 50\.0KB limit\. Use bash/);
		assert.doesNotMatch(singleLineResult.diagnostic, /COMPLETE_TAIL/);
		assert.equal(singleLineResult.tail.utf8, "完整😀COMPLETE_TAIL");
		assert.equal(singleLineResult.tail.bytesRead, 23);
		assert.equal(Buffer.from(singleLineResult.tail.base64, "base64").toString("utf8"), "完整😀COMPLETE_TAIL");
		assert.equal(singleLineResult.splitCodePoint.utf8, null, "Split code points never decode with silent replacements");
		assert.deepEqual(Buffer.from(singleLineResult.splitCodePoint.base64, "base64"), Buffer.from("完整😀COMPLETE_TAIL").subarray(1));
		assert.equal(singleLineResult.bounded.bytesRead, 4096);
		assert.deepEqual(Buffer.from(singleLineResult.bounded.base64, "base64"), Buffer.from(singleLineMarkdown).subarray(-4096));
		assert.equal(singleLineResult.invalidRangeRejected, true);
		singleLineSpill = results.filter((event) => event.toolName === "fetch_content").at(-1).structuredContent.fullOutputPath;
		assert.equal(readFileSync(singleLineSpill, "utf8"), singleLineMarkdown, "Spill text is not normalized or rewritten");
		assert.equal(statSync(singleLineSpill).mode & 0o777, 0o600);
		assert.equal(statSync(dirname(singleLineSpill)).mode & 0o777, 0o700);
		assert.ok(singleLineSpill.startsWith(spillDir), "Exercise quoting of the real spill path with shell metacharacters");
		assert.throws(() => statSync(join(cwd, "SHOULD_NOT_EXIST")), /ENOENT/);
		assert.equal(result.nestedCalls.calls.filter((call) => call.name === "bash").length, 3, "Invalid oversized range fails before tool dispatch");
		assert.ok(result.nestedCalls.calls.filter((call) => call.name === "bash").every((call) => call.status === "ok"));
		assert.ok(events.some((event) => event.type === "tool_execution_end" && event.parentToolCallId && event.toolName === "bash" && !event.isError));
		denyBash = true;
		result = await run("codemode", { code: `${boundedSpillExample}
try { text(await readSpillBytes(${JSON.stringify(singleLineSpill)},600000,23)); }
catch(e) { text("DENIED:" + e.message); }` });
		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.content), /DENIED:.*Fixture bash permission denied/);
		assert.doesNotMatch(JSON.stringify(result.content), /COMPLETE_TAIL/);
		assert.ok(result.nestedCalls.calls.some((call) => call.name === "bash" && call.status === "error"));
		assert.ok(calls.some((call) => call.toolName === "bash" && call.toolCallId.includes("/")));
		denyBash = false;
		result = await run("web_search", { query: "fail", provider: "firecrawl" });
		assert.equal(result.isError, true);
		assert.equal(result.details.ok, false);
		assert.equal(result.structuredContent, undefined);
		result = await run("x_search", { query: "fail" });
		assert.equal(result.isError, true);
		assert.equal(result.details.ok, false);
		assert.equal(result.structuredContent, undefined);
		result = await run("fetch_content", { url: "https://example.com/article", provider: "exa" });
		assert.equal(result.isError, true);
		assert.equal(result.details.code, "missing_config");
		assert.equal(result.structuredContent, undefined);
		const persisted = readFileSync(sessionManager.getSessionFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		for (const toolName of ["web_search", "x_search", "fetch_content"]) assert.ok(persisted.some((entry) => entry.message?.toolName === toolName && entry.message.isError === true));
		result = await run("codemode", { code: `try { await tools.web_search({query:"fail",provider:"firecrawl"}); text("BAD_SUCCESS"); } catch(e) { text("NATIVE_REJECTION:" + e.message); }` });
		assert.match(JSON.stringify(result.content), /NATIVE_REJECTION/);
		assert.doesNotMatch(JSON.stringify(result.content), /BAD_SUCCESS/);
		result = await run("codemode", { code: `const r = await Promise.allSettled([tools.x_search({query:"fail"}),tools.fetch_content({url:"https://example.com/article",provider:"exa"})]); text(r.map(v => v.status));` });
		assert.deepEqual(JSON.parse(result.content.at(-1).text), ["rejected", "rejected"]);
		deny = true;
		const before = requests.length;
		result = await run("codemode", { code: `try { await tools.fetch_content({url:"https://example.com/article",provider:"firecrawl"}); } catch(e) { text(e.message); }` });
		assert.match(JSON.stringify(result.content), /Fixture permission denied/);
		assert.equal(requests.length, before);
		assert.ok(calls.some((call) => call.toolName === "fetch_content" && call.toolCallId.includes("/")));
		deny = false;
		redact = true;
		result = await run("codemode", { code: `const r = await tools.web_search({query:"evidence",provider:"openai"}); text(r);` });
		assert.match(JSON.stringify(result.content), /redacted/);
		assert.doesNotMatch(JSON.stringify(result.content), /Fixture answer|Evidence text/);
		redact = false;
		const requested = new Promise((resolve) => { notifyRequest = resolve; });
		plans.push({ name: "codemode", args: { code: `await tools.web_search({query:"cancel",provider:"firecrawl"});` } });
		const running = session.prompt("Cancel the fixture call.");
		await requested;
		await session.abort();
		await running;
		assert.equal(cancellationObserved, true);
		assert.ok(events.some((event) => event.type === "tool_execution_end" && event.parentToolCallId && event.isError));
		console.log("Verified structured search/X and SSE envelope requestId, filter-fetch tail, owner-only multiline/read and single-line/bounded bash spills, exact UTF-8 bytes, shell quoting, native bash denial, persisted errors, rejection, permission, redaction, cancellation.");
	} finally {
		try {
			if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
			if (spill) assert.throws(() => statSync(spill), /ENOENT/);
			if (singleLineSpill) assert.throws(() => statSync(singleLineSpill), /ENOENT/);
		} finally {
			globalThis.fetch = originalFetch;
			for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
			rmSync(root, { recursive: true, force: true });
		}
	}
});
