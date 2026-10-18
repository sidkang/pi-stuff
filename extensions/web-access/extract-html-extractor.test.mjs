import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractWithHtmlExtractor } from "./extract-html-extractor.ts";
import { normalizeMarkdown } from "./extract-defuddle.ts";

const root = dirname(fileURLToPath(import.meta.url));

test("extractWithHtmlExtractor returns markdown for ordinary page fixture", async () => {
	const html = readFileSync(join(root, "fixtures/ordinary-page.html"), "utf8");
	const result = await extractWithHtmlExtractor(html, "https://example.com/ordinary");
	assert.equal(normalizeMarkdown(result.content).length > 0, true);
	assert.match(result.content, /primary article body/i);
});

test("extractWithHtmlExtractor returns markdown for X main post fixture", async () => {
	const html = readFileSync(join(root, "fixtures/x-main-post.html"), "utf8");
	const result = await extractWithHtmlExtractor(html, "https://x.com/fixture_user/status/1");
	assert.match(result.content, /Fixture X main post body/i);
});
