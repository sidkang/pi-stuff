import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractWithDefuddle, normalizeMarkdown } from "./extract-defuddle.ts";

const root = dirname(fileURLToPath(import.meta.url));

test("normalizeMarkdown trims and rewrites CRLF", () => {
	assert.equal(normalizeMarkdown("  a\r\nb\r\n  "), "a\nb");
	assert.equal(normalizeMarkdown("   "), "");
});

test("extractWithDefuddle returns markdown for ordinary page fixture", async () => {
	const html = readFileSync(join(root, "fixtures/ordinary-page.html"), "utf8");
	const result = await extractWithDefuddle(html, "https://example.com/ordinary");
	assert.match(result.content, /primary article body/i);
	assert.match(`${result.title}\n${result.content}`, /Ordinary Article Title/i);
});

test("extractWithDefuddle returns markdown for X main post fixture", async () => {
	const html = readFileSync(join(root, "fixtures/x-main-post.html"), "utf8");
	const result = await extractWithDefuddle(html, "https://x.com/fixture_user/status/1");
	assert.match(result.content, /Fixture X main post body/i);
	assert.doesNotMatch(result.content, /Reply composer chrome/i);
});
