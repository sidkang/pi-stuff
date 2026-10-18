import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createFetchRenderers,
	fetchCallPresentation,
	fetchResultPresentation,
	renderFetchToolResult,
} from "./fetch-presentation.ts";
import { renderFallbackToolShell } from "./better-tui-v1.ts";

const theme = {
	fg: (_name, value) => value,
	bg: (_name, value) => value,
	bold: (value) => value,
};

const longXueqiuTitle =
	"川糖周掌门：茅台2026半年报 茅台 $贵州茅台(SH600519)$ 昨晚发了2026年半年报，今天跟大家聊聊我个人的看法，其实就是三句话： 1、市场占有率比短期利润更重要。上半年在主动降价让利的背景下，营收还守住了增长，说明茅台守住了市场。";

function render(component, width = 80) {
	return component.render(width).map((line) => line.trimEnd()).join("\n");
}

test("fetchCallPresentation uses Fetch Content action and truncated target", () => {
	const presentation = fetchCallPresentation({
		url: "https://example.com/very/long/path/that/should/be/truncated/for/display/purposes/extra",
	});
	assert.equal(presentation.action, "Fetch Content");
	assert.ok(presentation.target.endsWith("…") || presentation.target.endsWith("..."));
});

test("fetchResultPresentation covers partial success truncation and error", () => {
	const partial = fetchResultPresentation({
		content: [{ type: "text", text: "Fetching..." }],
		details: { phase: "Connecting to browser...", elapsedMs: 1200 },
	}, true, false);
	assert.equal(partial.status, "running");
	assert.equal(partial.outcome, "Connecting to browser...");

	const success = fetchResultPresentation({
		content: [{ type: "text", text: "# Title\n\nbody" }],
		details: {
			requestedUrl: "https://example.com/a",
			url: "https://example.com/a",
			title: "Title",
			totalChars: 12,
			returnedChars: 12,
			truncated: true,
			kernel: "defuddle",
			elapsedMs: 900,
		},
	}, false, false);
	assert.equal(success.status, "success");
	assert.equal(success.outcome, "truncated");
	assert.ok(success.metadata?.some((item) => item.includes("chars")));

	const error = fetchResultPresentation({
		content: [{ type: "text", text: "No CDP endpoint is configured." }],
		details: {
			ok: false,
			error: "No CDP endpoint is configured.",
			code: "missing_config",
		},
	}, false, true);
	assert.equal(error.status, "error");
	assert.equal(error.outcome, "missing_config");
});

test("fetch Better TUI presentation samples both body ends and names the returned slice", () => {
	const body = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
	const presentation = fetchResultPresentation({
		content: [{ type: "text", text: body }],
		details: {
			ok: true,
			totalChars: 1_000,
			returnedChars: 300,
			truncated: true,
			kernel: "defuddle",
		},
	}, false, false);

	assert.deepEqual(presentation.body, [{ kind: "text", text: body, strategy: "head-tail" }]);
	assert.ok(presentation.metadata?.includes("300 / 1000 chars"));
});

test("createFetchRenderers produce compact Nico-style call without giant title row", () => {
	const renderers = createFetchRenderers();
	const call = renderers.renderCall({ url: "https://example.com/path" }, theme, {});
	assert.ok(typeof call.render === "function");
	const rows = call.render(80);
	const joined = rows.join("\n");
	assert.match(joined, /fetch /);
	assert.match(joined, /example\.com/);
	assert.doesNotMatch(joined, /\$ Fetch Content/);
});

test("collapsed fetch with long Xueqiu title stays multi-line and bounded", () => {
	const body = "## 标题\n\n三个市场化的地基上半年都在一点点打牢；往后看，改革最痛的一段已经过去。\n";
	const component = renderFetchToolResult({
		content: [{ type: "text", text: body }],
		details: {
			ok: true,
			title: longXueqiuTitle,
			totalChars: body.length,
			returnedChars: body.length,
			truncated: false,
			kernel: "defuddle",
			elapsedMs: 6683,
		},
	}, false, false, theme);

	const width = 48;
	const lines = component.render(width);
	const joined = lines.join("\n");
	assert.match(joined, /chars|defuddle|6\.7s|6s/);
	assert.match(joined, /三个市场化|标题/);
	// Must not put the entire page title on a single status line as `ok · <title>`.
	assert.doesNotMatch(joined, /^ok ·/);
	assert.ok(!joined.includes(longXueqiuTitle), "full title must not appear unclipped");
	assert.ok(lines.length >= 2, "status + title/preview rows");
	assert.match(lines.at(-2), /Took 6\.7s.*chars.*defuddle/, "metrics and timing belong above the bottom padding");
});

test("fetch call background follows execution status and presentation state supplies footer timing", (t) => {
	const originalNow = Date.now;
	let now = 10_000;
	Date.now = () => now;
	t.after(() => {
		Date.now = originalNow;
	});
	const markedTheme = {
		...theme,
		bg: (name, value) => `<${name}>${value}</${name}>`,
	};
	const renderers = createFetchRenderers();
	const state = {};
	const context = { state, invalidate() {} };
	const call = renderers.renderCall({ url: "https://example.com/article" }, markedTheme, context);
	assert.match(call.render(80).join("\n"), /toolPendingBg/, "call row uses pending background while running");

	now = 12_500;
	const result = renderers.renderResult({
		content: [{ type: "text", text: "# Article\n\nReadable preview." }],
		details: { title: "Article", totalChars: 17, kernel: "defuddle", truncated: false },
	}, { expanded: false, isPartial: false }, markedTheme, context);
	const rows = result.render(80);
	assert.match(rows.at(-2), /Took 2\.5s.*17 chars.*defuddle/, "footer precedes the bottom background padding");
	const completedCall = call.render(80).join("\n");
	assert.match(completedCall, /toolSuccessBg/, "terminal success recolors the persisted call row");
	assert.doesNotMatch(completedCall, /toolPendingBg/, "completed call no longer looks pending");
});

test("expanded fetch keeps metrics footer after the body", () => {
	const component = renderFetchToolResult({
		content: [{ type: "text", text: "# Article\n\nFirst paragraph.\n\nSecond paragraph." }],
		details: { title: "Article", totalChars: 42, kernel: "defuddle", elapsedMs: 3100 },
	}, true, false, theme);
	const rows = component.render(80).map((line) => line.trimEnd());
	assert.ok(rows.findIndex((line) => line.includes("First paragraph")) < rows.length - 1);
	assert.match(rows.at(-2), /Took 3\.1s.*42 chars.*defuddle/);
});

test("expanded native fetch samples both body ends when display output is bounded", () => {
	const tail = "Showing 4000 of 12000 characters. The omitted tail is not retrievable.";
	const body = [
		"# Article",
		"Head marker.",
		...Array.from({ length: 400 }, (_, index) => `middle line ${index + 1} ${"x".repeat(20)}`),
		"---",
		tail,
	].join("\n");
	const component = renderFetchToolResult({
		content: [{ type: "text", text: body }],
		details: {
			ok: true,
			title: "Article",
			totalChars: 12_000,
			returnedChars: 4_000,
			truncated: true,
			kernel: "defuddle",
			elapsedMs: 1000,
		},
	}, true, false, theme);
	const rendered = render(component, 200);

	assert.match(rendered, /Head marker\./);
	assert.match(rendered, /middle content omitted from display/);
	assert.ok(rendered.includes(tail));
	assert.match(rendered, /4000 \/ 12000 chars/);
	assert.doesNotMatch(rendered, /middle line 200/);
});

test("expanded native fetch wraps long source lines with the normal tool output color", () => {
	const colors = [];
	const body = `Head marker. ${"bodyword ".repeat(150)}Tail marker.`;
	const component = renderFetchToolResult({
		content: [{ type: "text", text: body }],
		details: { ok: true, totalChars: body.length, returnedChars: body.length, kernel: "defuddle" },
	}, true, false, {
		...theme,
		fg: (name, value) => {
			colors.push(name);
			return value;
		},
	});
	const rows = component.render(40).map((line) => line.trim());

	assert.ok(colors.includes("toolOutput"));
	assert.ok(rows.filter((line) => line.includes("bodyword")).length > 2, "long body wraps across rows");
	assert.ok(rows.some((line) => line.includes("Tail marker.")), "body tail remains visible");
	assert.ok(!rows.some((line) => line.includes("…")), "width wrapping does not manufacture an ellipsis");
	assertWidthSafe(component, [40]);
});

test("fallback shell paints its defensive truncation ellipsis", () => {
	const reset = "\x1b[0m";
	const background = "\x1b[48;5;22m";
	const component = renderFallbackToolShell({
		render() {
			return ["X".repeat(100)];
		},
		invalidate() {},
	}, {
		...theme,
		bg: (_name, value) => `${background}${value}${reset}`,
	}, "success");
	const [row] = component.render(20);

	assert.ok(row.includes(`${reset}${background}…`));
});

test("collapsed fetch puts the omission hint after the body preview", () => {
	const component = renderFetchToolResult({
		content: [{ type: "text", text: "# Article\n\nFirst body line.\nSecond body line.\nThird body line.\nFourth body line." }],
		details: { title: "Article", totalChars: 80, kernel: "defuddle", elapsedMs: 8000 },
	}, false, false, theme);
	const rows = component.render(80).map((line) => line.trim());
	const first = rows.findIndex((line) => line.includes("First body line"));
	const hint = rows.findIndex((line) => line.includes("2 more lines · ctrl+o to expand"));
	const footer = rows.findIndex((line) => line.includes("Took 8.0s · 80 chars · defuddle"));
	assert.ok(first >= 0 && first < hint && hint < footer);
	assert.equal(rows.at(-1), "", "result owns a bottom background blank row");
});

test("createFetchRenderers result shell has no leading double blank artifact", () => {
	const renderers = createFetchRenderers();
	const result = renderers.renderResult({
		content: [{ type: "text", text: "hello body" }],
		details: {
			requestedUrl: "https://example.com",
			url: "https://example.com",
			title: "hello",
			totalChars: 10,
			returnedChars: 10,
			truncated: false,
			kernel: "defuddle",
			elapsedMs: 1000,
		},
	}, { expanded: false, isPartial: false }, theme, {});
	const rows = result.render(80);
	assert.ok(rows.length >= 1);
	assert.notEqual(rows[0], "".padEnd(80));
	assert.ok(rows[0].trim().length > 0, "first row is content, not a blank full-width pad");
});

function assertWidthSafe(component, widths = [1, 2, 18, 36]) {
	for (const width of widths) {
		const lines = component.render(width);
		assert.ok(lines.length > 0, `width ${width} returns rows`);
		for (const line of lines) {
			const vw = visibleWidth(line);
			assert.ok(vw <= width, `expected visibleWidth ${vw} for ${JSON.stringify(line)} to fit width ${width}`);
		}
	}
}

test("fetch call/partial/collapsed/expanded all fit Pi width contract", () => {
	const renderers = createFetchRenderers();
	const longUrl = "https://xueqiu.com/8106514687/405161153?utm_source=test&path=" + "a".repeat(80);
	assertWidthSafe(renderers.renderCall({ url: longUrl }, theme, {}));
	assertWidthSafe(renderers.renderResult({
		details: { phase: "Connecting to browser for a very long readiness phase label", startedAt: Date.now() - 1500 },
	}, { expanded: false, isPartial: true }, theme, {}));
	const success = {
		content: [{ type: "text", text: "## 标题\n\n" + "正文内容，".repeat(200) }],
		details: {
			ok: true,
			title: longXueqiuTitle,
			totalChars: 4000,
			returnedChars: 4000,
			truncated: false,
			kernel: "defuddle",
			elapsedMs: 6683,
		},
	};
	assertWidthSafe(renderers.renderResult(success, { expanded: false, isPartial: false }, theme, {}));
	assertWidthSafe(renderers.renderResult(success, { expanded: true, isPartial: false }, theme, {}));
});

test("fetch expanded long single-line error is hard-bounded", () => {
	const longError = `Captured HTML exceeds the limit ${"Z".repeat(5_000)}`;
	const component = renderFetchToolResult({
		content: [{ type: "text", text: longError }],
		details: { ok: false, code: "backend_error", error: longError, elapsedMs: 1200 },
	}, true, false, theme);
	const joined = render(component, 36);
	assert.match(joined, /backend_error|failed|1\.2s/);
	assert.ok(!joined.includes("Z".repeat(300)), "expanded error must not dump unbounded single-line detail");
	assertWidthSafe(component);
});

test("native fetch render strips OSC52/OSC title/CSI from body, title, and errors", () => {
	const injected = "Body\x1b]52;c;SGk=\x07 text\x1b]0;title\x07\x1b[2J";
	const success = render(renderFetchToolResult({
		content: [{ type: "text", text: injected }],
		details: {
			ok: true,
			title: `Page\x1b]0;evil\x07Title`,
			totalChars: injected.length,
			returnedChars: injected.length,
			elapsedMs: 1000,
		},
	}, true, false, theme));
	assert.match(success, /Body/);
	assert.doesNotMatch(success, /\x1b|\x07|evil|52;c/);

	const errorOut = render(renderFetchToolResult({
		content: [{ type: "text", text: injected }],
		details: { ok: false, code: "backend_error", error: injected, elapsedMs: 900 },
	}, true, false, theme));
	assert.doesNotMatch(errorOut, /\x1b|\x07|52;c/);
});
