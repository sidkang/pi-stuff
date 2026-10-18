import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	documentHasHanTypographyElements,
	hasHanTypographyWrappers,
	normalizeHanTypographyHtml,
	normalizeHanTypographyHtmlWithParser,
	unwrapHanTypographyNodes,
} from "./extract-html-normalize.ts";
import { extractWithDefuddle } from "./extract-defuddle.ts";
import { extractWithHtmlExtractor } from "./extract-html-extractor.ts";
import { runExtractionKernels } from "./extract-kernels.ts";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = () => readFileSync(join(root, "fixtures/han-cjk-punctuation.html"), "utf8");

test("hasHanTypographyWrappers is a cheap presence check", () => {
	assert.equal(hasHanTypographyWrappers("<p>hello</p>"), false);
	assert.equal(hasHanTypographyWrappers('<h-char class="biaodian"><h-inner>，</h-inner></h-char>'), true);
	assert.equal(hasHanTypographyWrappers('<h-cs hidden class="jinze-outer"> </h-cs>'), true);
	assert.equal(hasHanTypographyWrappers('<h-hws hidden> </h-hws>'), true);
});

test("normalizeHanTypographyHtml unwraps punctuation wrappers and keeps links", async () => {
	const html = fixture();
	const normalized = await normalizeHanTypographyHtml(html);
	assert.equal(hasHanTypographyWrappers(normalized), false);
	assert.match(normalized, /三个市场化的地基上半年都在一点点打牢；往后看，改革最痛的一段已经过去/);
	assert.match(normalized, /href="https:\/\/example.com\/stock"/);
	// Semantic ruby tags are preserved.
	assert.match(normalized, /<h-ruby/i);
	assert.match(normalized, /<h-yin/i);
});

test("h-cs and h-hws synthetic spacing nodes are dropped without preserving child spaces", async () => {
	const html = [
		"<p>汉",
		'<h-hws hidden> </h-hws>',
		"字",
		'<h-cs hidden class="jinze-outer hangable-outer"> </h-cs>',
		"标点",
		"</p>",
	].join("");
	const normalized = await normalizeHanTypographyHtml(html);
	assert.equal(hasHanTypographyWrappers(normalized), false);
	assert.doesNotMatch(normalized, /h-hws/i);
	assert.doesNotMatch(normalized, /h-cs/i);
	// No artificial spaces from dropped control nodes.
	assert.match(normalized, /汉字标点/);
	assert.doesNotMatch(normalized, /汉 字/);
	assert.doesNotMatch(normalized, /字 标点/);
});

test("regex false positives in script/style/raw text keep original HTML byte-identical", async () => {
	const html = [
		"<!doctype html><html><head><style>",
		".x::before{content:'<h-char class=\"biaodian\">，</h-char>'}",
		"</style><script>",
		"const sample = '<h-hws hidden> </h-hws><h-cs></h-cs>';",
		"</script></head><body><p>no real wrappers</p></body></html>",
	].join("");
	assert.equal(hasHanTypographyWrappers(html), true, "cheap precheck may match text");
	const out = await normalizeHanTypographyHtml(html);
	assert.equal(out, html, "must return original string when DOM has no matching elements");
});

test("ordinary HTML is returned unchanged without parsing side effects", async () => {
	const ordinary = readFileSync(join(root, "fixtures/ordinary-page.html"), "utf8");
	const out = await normalizeHanTypographyHtml(ordinary);
	assert.equal(out, ordinary);
});

test("unwrapHanTypographyNodes works with linkedom parseHTML", async () => {
	const { parseHTML } = await import("linkedom");
	const html = '<p>a<h-char><h-inner>，</h-inner></h-char>b</p>';
	const { document } = parseHTML(html);
	assert.equal(documentHasHanTypographyElements(document), true);
	const changed = unwrapHanTypographyNodes(document);
	assert.ok(changed >= 1);
	assert.equal(document.querySelector("p")?.textContent, "a，b");
	const again = normalizeHanTypographyHtmlWithParser(html, parseHTML);
	assert.match(again, /a，b/);
});

test("Defuddle keeps Han-wrapped Chinese punctuation inline", async () => {
	const result = await extractWithDefuddle(fixture(), "https://xueqiu.com/fixture/1");
	// Must not produce one-punctuation-per-paragraph artifacts.
	assert.doesNotMatch(result.content, /^，$/m);
	assert.doesNotMatch(result.content, /^。$/m);
	assert.doesNotMatch(result.content, /\n，\n/);
	assert.match(result.content, /三个市场化的地基上半年都在一点点打牢；往后看，改革最痛的一段已经过去/);
	assert.match(result.content, /以后只会比之前好走，多留点时间。/);
});

test("html-extractor keeps Han-wrapped Chinese punctuation order", async () => {
	const result = await extractWithHtmlExtractor(fixture(), "https://xueqiu.com/fixture/1");
	assert.doesNotMatch(result.content, /\n，\n/);
	// Exact sentence order with inline punctuation (may strip some markdown link chrome).
	assert.match(result.content.replace(/\s+/g, ""), /三个市场化的地基上半年都在一点点打牢；往后看，改革最痛的一段已经过去/);
});

test("runExtractionKernels aborts before normalizer and runners when signal already aborted", async () => {
	const signal = AbortSignal.abort(new DOMException("already aborted", "AbortError"));
	let runnerCalled = false;
	await assert.rejects(
		() => runExtractionKernels({
			selected: "defuddle",
			html: fixture(),
			url: "https://xueqiu.com/fixture/1",
			signal,
			runners: {
				async defuddle() {
					runnerCalled = true;
					return { content: "should not run" };
				},
			},
		}),
		(error) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(runnerCalled, false);
});

test("runExtractionKernels races normalization against an aborting signal", async () => {
	const controller = new AbortController();
	const huge = `<html><body>${"<p>x</p>".repeat(50_000)}<h-char><h-inner>，</h-inner></h-char></body></html>`;
	const pending = runExtractionKernels({
		selected: "defuddle",
		html: huge,
		url: "https://example.com",
		signal: controller.signal,
		runners: {
			async defuddle() {
				return { content: "late" };
			},
		},
	});
	// Abort immediately so normalization cannot complete uncontested.
	queueMicrotask(() => controller.abort(new DOMException("aborted during normalize", "AbortError")));
	await assert.rejects(
		() => pending,
		(error) => error instanceof Error && error.name === "AbortError",
	);
});
