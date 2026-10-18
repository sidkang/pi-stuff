import assert from "node:assert/strict";
import { dirname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import webAccess from "./index.ts";
import { searchToolResult } from "./responses-client.ts";
import { FetchOutputSchema, SearchOutputSchema } from "./result-schema.ts";
import { createCompleteOutputStore, MAX_COMPLETE_MARKDOWN_BYTES, MAX_SESSION_SPILL_FILES, MAX_STRUCTURED_MARKDOWN_BYTES } from "./complete-output.ts";

test("search structured result validates, preserves text, citations, source metadata and excludes transport secrets", () => {
	const result = searchToolResult("query", {
		answer: "answer", sources: [{ title: "Example", url: "https://example.com", snippet: "excerpt", publishedDate: "2026-01-01" }],
		citations: [{ title: "Example", url: "https://example.com", citedText: "citation" }], citationUrls: ["https://example.com"],
		model: "model", requestId: "request", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, outputItems: [{ secret: "private" }],
	}, { source: "openai", provider: "proxy", model: "model", api: "openai-responses", elapsedMs: 10, timeoutMs: 60000, apiKey: "private", headers: { Authorization: "private" } });
	assert.equal(Value.Check(SearchOutputSchema, result.structuredContent), true);
	assert.equal(result.structuredContent.answer, "answer");
	assert.equal(result.structuredContent.citations[0].citedText, "citation");
	assert.equal(result.structuredContent.provider, "proxy");
	assert.equal(result.structuredContent.requestId, "request");
	assert.equal(result.details.sourceCount, result.structuredContent.sources.length);
	assert.equal(result.details.ok, true);
	assert.match(result.content[0].text, /^answer\n\nSources:/);
	assert.doesNotMatch(JSON.stringify(result.structuredContent), /private|Authorization|outputItems/);
	assert.equal(Value.Check(SearchOutputSchema, searchToolResult("empty answer", { sources: [] }).structuredContent), true);
});

test("all public tools declare data output and conservative network annotations without changing exposure", () => {
	const tools = [];
	webAccess({ on() {}, registerTool: (tool) => tools.push(tool) });
	for (const tool of tools) {
		assert.ok(tool.outputSchema);
		assert.equal(tool.exposure, undefined);
		assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true });
	}
	assert.equal(tools[0].outputSchema, SearchOutputSchema);
	assert.equal(tools[1].outputSchema, SearchOutputSchema);
	assert.equal(tools[2].outputSchema, FetchOutputSchema);
});

test("complete output uses UTF-8 limits, secure exact spills and idempotent cleanup", async () => {
	const store = createCompleteOutputStore();
	let spilled;
	try {
		const atLimit = "x".repeat(MAX_STRUCTURED_MARKDOWN_BYTES);
		const inline = await store.prepare(atLimit);
		assert.equal(inline.markdown, atLimit);
		assert.equal(inline.structuredTruncated, false);
		const complete = `${"😀".repeat(MAX_STRUCTURED_MARKDOWN_BYTES / 4)}COMPLETE_TAIL`;
		spilled = await store.prepare(complete);
		assert.equal(spilled.markdown, "");
		assert.equal(spilled.structuredChars, 0);
		assert.equal(spilled.structuredTruncated, true);
		assert.equal(spilled.totalBytes, Buffer.byteLength(complete));
		assert.equal(await readFile(spilled.fullOutputPath, "utf8"), complete);
		assert.equal((await stat(spilled.fullOutputPath)).mode & 0o777, 0o600);
		assert.equal((await stat(dirname(spilled.fullOutputPath))).mode & 0o777, 0o700);
		await assert.rejects(store.prepare("x".repeat(MAX_COMPLETE_MARKDOWN_BYTES + 1)), /64 MiB/);
	} finally { await store.clear(); await store.clear(); }
	await assert.rejects(stat(spilled.fullOutputPath), /ENOENT/);
});

test("parallel spills cannot exceed session file bounds and shutdown waits for pending writes", async () => {
	const store = createCompleteOutputStore();
	const results = await Promise.allSettled(Array.from({ length: MAX_SESSION_SPILL_FILES + 1 }, () => store.prepare("x".repeat(MAX_STRUCTURED_MARKDOWN_BYTES + 1))));
	assert.equal(results.filter((result) => result.status === "fulfilled").length, MAX_SESSION_SPILL_FILES);
	assert.match(results.find((result) => result.status === "rejected").reason.message, /storage limit/);
	await store.clear();
	for (const result of results.filter((result) => result.status === "fulfilled")) await assert.rejects(stat(result.value.fullOutputPath), /ENOENT/);
	const pendingStore = createCompleteOutputStore();
	const pending = pendingStore.prepare("x".repeat(MAX_STRUCTURED_MARKDOWN_BYTES + 1));
	await pendingStore.clear();
	await assert.rejects(stat((await pending).fullOutputPath), /ENOENT/);
	await assert.rejects(pendingStore.prepare("after shutdown"), /closed/);
	const cancelled = createCompleteOutputStore();
	await assert.rejects(cancelled.prepare("x".repeat(MAX_STRUCTURED_MARKDOWN_BYTES + 1), AbortSignal.abort()), /aborted/);
	await cancelled.clear();
});
