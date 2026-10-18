import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
	presentToolCall,
	presentToolResult,
	renderFallbackToolShell,
	type FallbackToolStatus,
	type BetterTuiRendererSpecV1,
	type BetterTuiRendererStateV1,
	type ToolCallPresentationV1,
	type ToolResultPresentationV1,
} from "./better-tui-v1.ts";
import { isRecord } from "./responses-client.ts";
import { sanitizeUntrustedTerminalText } from "./terminal-text.ts";

type SearchRenderResult = { content?: unknown; details?: unknown; isError?: boolean };
type SearchRenderState = Record<string, unknown> & BetterTuiRendererStateV1 & {
	elapsedTimer?: ReturnType<typeof setInterval>;
	fallbackStatus?: FallbackToolStatus;
};
type SearchRenderContext = { isError?: boolean; state?: SearchRenderState; invalidate?: () => void };

export type SearchPresentationKind = "web" | "x";

/** Bounded display helpers (Nico-style; never dump full titles/URLs into one TUI row). */
export const PREVIEW_MAX_CHARS = 120;
export const QUERY_DISPLAY_MAX = 60;
/** Expanded error/detail line and total bounds before Text wrapping. */
export const EXPANDED_ERROR_MAX_LINES = 20;
export const EXPANDED_ERROR_LINE_MAX_CHARS = 200;
export const EXPANDED_ERROR_TOTAL_MAX_CHARS = 2_000;
export const EXPANDED_BODY_MAX_CHARS = 4_000;
const EXPANDED_BODY_MIDDLE_OMISSION = "… middle content omitted from display …";

export function formatSeconds(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

export function boundDisplay(text: string, max: number): string {
	const trimmed = sanitizeUntrustedTerminalText(text).replace(/\s+/g, " ").trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim()) return item.text.trim();
	}
	return undefined;
}

type ParsedSourceEntry = { title: string; url: string; snippet?: string };

function parseFormattedSourceEntries(block: string): ParsedSourceEntry[] | undefined {
	const entries: ParsedSourceEntry[] = [];
	let current: { title: string; lines: string[] } | undefined;
	const lines = block.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trimEnd();
		const heading = line.trim().match(/^\[\d+\]\s+(.+)$/);
		// Excerpts may contain numbered citations; only a title/URL pair starts an entry.
		if (heading && /^https?:\/\/\S+$/.test(lines[index + 1]?.trim() ?? "")) {
			if (current) {
				const parsed = finishSourceEntry(current);
				if (!parsed) return undefined;
				entries.push(parsed);
			}
			current = { title: heading[1]!.trim(), lines: [] };
			continue;
		}
		if (!current) {
			if (line.trim()) return undefined;
			continue;
		}
		current.lines.push(line);
	}
	if (current) {
		const parsed = finishSourceEntry(current);
		if (!parsed) return undefined;
		entries.push(parsed);
	}
	return entries.length > 0 ? entries : undefined;
}

function finishSourceEntry(entry: { title: string; lines: string[] }): ParsedSourceEntry | undefined {
	const nonempty = entry.lines.map((line) => line.trim()).filter(Boolean);
	if (nonempty.length === 0) return undefined;
	const url = nonempty[0]!;
	if (!/^https?:\/\/\S+$/.test(url)) return undefined;
	const snippet = nonempty.slice(1).join("\n").trim();
	return snippet ? { title: entry.title, url, snippet } : { title: entry.title, url };
}

function isFormattedSourcesBlock(block: string): boolean {
	return parseFormattedSourceEntries(block) !== undefined;
}

function sourcesBlockFromText(text: string): string | undefined {
	const matches = [...text.matchAll(/\r?\n\r?\nSources:\s*\r?\n/g)];
	const last = matches.at(-1);
	if (last && last.index !== undefined) {
		const block = text.slice(last.index + last[0].length).trim();
		return isFormattedSourcesBlock(block) ? block : undefined;
	}
	const only = text.match(/^Sources:\s*\r?\n([\s\S]*)$/i);
	if (!only?.[1]) return undefined;
	const block = only[1].trim();
	return isFormattedSourcesBlock(block) ? block : undefined;
}

function retrievalDisplayLines(text: string): string[] {
	const block = sourcesBlockFromText(text) ?? (isFormattedSourcesBlock(text.trim()) ? text.trim() : undefined);
	if (!block) return trimBlankLines(text.split(/\r?\n/));
	const entries = parseFormattedSourceEntries(block) ?? [];
	const lines: string[] = [];
	for (const entry of entries) {
		if (lines.length > 0) lines.push("");
		lines.push(entry.title);
		lines.push(entry.url);
		if (entry.snippet) lines.push(entry.snippet);
	}
	return lines;
}

function stripAppendedSourcesBlock(text: string, sourceCount: number | undefined): string {
	if (!sourceCount || sourceCount <= 0) return text.trim();
	const matches = [...text.matchAll(/\r?\n\r?\nSources:\s*\r?\n/g)];
	const last = matches.at(-1);
	if (!last || last.index === undefined) return text.trim();
	const block = text.slice(last.index + last[0].length).trim();
	if (!isFormattedSourcesBlock(block)) return text.trim();
	return text.slice(0, last.index).trim();
}

function isSourceHeadingLine(line: string): boolean {
	return /^(?:来源|资料来源|参考来源|参考资料|出处|引用)\s*[:：]?\s*.*$/i.test(line.trim())
		|| /^(?:sources?|references?|citations?)\s*:?\s*.*$/i.test(line.trim());
}

function isUrlOnlyLine(line: string): boolean {
	return /^[-*•]?\s*<?https?:\/\/\S+>?\s*$/.test(line.trim());
}

function isAnswerBoundaryLine(line: string): boolean {
	return /^\s*(?:\d+\.\s+|[-*•]\s+\*\*|#{1,6}\s+)/.test(line);
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]!.trim() === "") start++;
	while (end > start && lines[end - 1]!.trim() === "") end--;
	return lines.slice(start, end);
}

function stripSourceOnlyLines(lines: string[]): string[] {
	const result: string[] = [];
	let skippingSourceBlock = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (skippingSourceBlock) {
			if (!trimmed) {
				if (result.length > 0 && result[result.length - 1]!.trim() !== "") result.push("");
				skippingSourceBlock = false;
				continue;
			}
			if (!isAnswerBoundaryLine(line)) continue;
			skippingSourceBlock = false;
		}

		if (isSourceHeadingLine(line)) {
			skippingSourceBlock = true;
			continue;
		}
		if (isUrlOnlyLine(line)) continue;
		if (!trimmed && (result.length === 0 || result[result.length - 1]!.trim() === "")) continue;
		result.push(line);
	}
	return trimBlankLines(result);
}

function answerLinesFromContent(content: unknown, sourceCount: number | undefined): string[] {
	const text = firstTextContent(content);
	if (!text) return [];
	const trimmed = text.trim();
	// Retrieval-only tool text is a Sources block with titles/URLs/excerpts and no model answer.
	if (/^Sources:\s*\r?\n/i.test(trimmed)) {
		// If parsing fails, preserve the retrieval text rather than treating it as noise.
		return retrievalDisplayLines(text);
	}
	const answer = stripAppendedSourcesBlock(text, sourceCount);
	if (answer) return stripSourceOnlyLines(answer.split(/\r?\n/));
	return retrievalDisplayLines(text);
}

/** Bounded meaningful lines for collapsed previews, with an exact omitted-line count. */
export function collapsedContentPreview(
	text: string,
	options: { maxLines?: number; skipHeadings?: boolean; maxChars?: number } = {},
): { lines: string[]; omittedLines: number } {
	const maxLines = options.maxLines ?? 2;
	const maxChars = options.maxChars ?? PREVIEW_MAX_CHARS;
	const meaningful = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
		if (!line) return false;
		if (line === "---" || line.startsWith("[") && line.endsWith("]")) return false;
		if (options.skipHeadings && line.startsWith("#")) return false;
		return true;
	});
	const lines = meaningful.slice(0, maxLines).map((line) => boundDisplay(line.replace(/\*\*/g, "").replace(/`/g, ""), maxChars));
	return { lines, omittedLines: Math.max(0, meaningful.length - lines.length) };
}

export function moreLinesLabel(count: number): string {
	return `${count} more ${count === 1 ? "line" : "lines"} · ctrl+o to expand`;
}

export function searchCallPresentation(kind: SearchPresentationKind, args: unknown): ToolCallPresentationV1 {
	const value = isRecord(args) ? args : {};
	const query = textValue(value.query) ?? (kind === "x" ? "x" : "web");
	const metadata = [
		numberValue(value.limit) !== undefined ? `limit ${numberValue(value.limit)}` : undefined,
		Array.isArray(value.allowed_domains) && value.allowed_domains.length > 0 ? `${value.allowed_domains.length} domain${value.allowed_domains.length === 1 ? "" : "s"}` : undefined,
	].filter((item): item is string => Boolean(item));
	const presentation: ToolCallPresentationV1 = {
		action: kind === "x" ? "X Search" : "Search",
		target: boundDisplay(query, QUERY_DISPLAY_MAX),
	};
	if (metadata.length > 0) presentation.metadata = metadata;
	return presentation;
}

export function searchResultPresentation(kind: SearchPresentationKind, result: SearchRenderResult, isPartial: boolean, isError: boolean): ToolResultPresentationV1 {
	const details = isRecord(result.details) ? result.details : {};
	if (isPartial) {
		const elapsedMs = numberValue(details.elapsedMs);
		return { status: "running", outcome: kind === "x" ? "searching X" : "searching", metadata: elapsedMs !== undefined ? [formatSeconds(elapsedMs)] : undefined };
	}
	const ok = details.ok === false ? false : !isError && result.isError !== true;
	const sourceCount = numberValue(details.sourceCount);
	const elapsedMs = numberValue(details.elapsedMs);
	const code = textValue(details.code);
	const statusCode = numberValue(details.status);
	const error = textValue(details.error) ?? (!ok ? firstTextContent(result.content) : undefined);
	const metadata = [
		statusCode !== undefined ? `HTTP ${statusCode}` : undefined,
		elapsedMs !== undefined ? formatSeconds(elapsedMs) : undefined,
	].filter((item): item is string => Boolean(item));
	if (!ok) return { status: "error", outcome: code ?? "failed", metadata: metadata.length > 0 ? metadata : undefined, error: error ?? `${kind === "x" ? "x" : "web"} search failed` };
	const answer = answerLinesFromContent(result.content, sourceCount).join("\n");
	return {
		status: "success",
		outcome: sourceCount === undefined ? "completed" : plural(sourceCount, "source"),
		metadata: metadata.length > 0 ? metadata : undefined,
		body: answer ? [{ kind: "text", text: answer, strategy: "head-tail" }] : undefined,
	};
}

export function webSearchCallPresentation(args: unknown): ToolCallPresentationV1 {
	return searchCallPresentation("web", args);
}

export function webSearchResultPresentation(result: SearchRenderResult, isPartial: boolean, isError: boolean): ToolResultPresentationV1 {
	return searchResultPresentation("web", result, isPartial, isError);
}

export function xSearchCallPresentation(args: unknown): ToolCallPresentationV1 {
	return searchCallPresentation("x", args);
}

export function xSearchResultPresentation(result: SearchRenderResult, isPartial: boolean, isError: boolean): ToolResultPresentationV1 {
	return searchResultPresentation("x", result, isPartial, isError);
}

function betterTuiSpec(kind: SearchPresentationKind): BetterTuiRendererSpecV1<unknown, unknown, SearchRenderState> {
	return {
		call(args) {
			return searchCallPresentation(kind, args);
		},
		result(result, options, context) {
			return searchResultPresentation(kind, result, options.isPartial, context.isError === true);
		},
		resultOptions: { textLines: 40, bodyLines: 50 },
	};
}

export function updateElapsedTimer(isPartial: boolean, context: SearchRenderContext): void {
	const state = context.state as SearchRenderState | undefined;
	if (!state) return;

	if (isPartial && !context.isError && !state.elapsedTimer && context.invalidate) {
		state.elapsedTimer = setInterval(() => context.invalidate?.(), 1000);
	}

	if ((!isPartial || context.isError) && state.elapsedTimer) {
		clearInterval(state.elapsedTimer);
		state.elapsedTimer = undefined;
	}
}

/** Wrap styled logical rows before the shell applies its status background. */
function multiLineText(lines: string[]): Component {
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, Math.floor(width) || 1);
			return lines.length > 0
				? lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth))
				: [""];
		},
		invalidate() {},
	};
}

/** Build one native fallback result section with a background-colored bottom blank row. */
export function nativeShell(theme: Theme, status: FallbackToolStatus, lines: string[]): Component {
	return renderFallbackToolShell(multiLineText([...lines, ""]), theme, status);
}

/** Call section owns the top blank row and the blank separator before result content. */
export function nativeCallShell(theme: Theme, status: () => FallbackToolStatus, line: string): Component {
	return renderFallbackToolShell(multiLineText(["", line, ""]), theme, status);
}

/** Partial result section finishes the pending fallback region with a background blank row. */
export function nativePartialShell(component: Component, theme: Theme): Component {
	const padded: Component = {
		render(width: number) {
			return [...component.render(width), ""];
		},
		invalidate() {
			component.invalidate?.();
		},
	};
	return renderFallbackToolShell(padded, theme, "pending");
}

/** Partial progress line: always ANSI-safe truncate to the requested width. */
export function renderPartialProgressLine(theme: Theme, phase: string, startedAt: number | undefined): Component {
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			const elapsed = startedAt === undefined ? "" : ` ${formatSeconds(Date.now() - startedAt)}`;
			const safePhase = sanitizeUntrustedTerminalText(phase).replace(/\s+/g, " ").trim() || "working";
			return [truncateToWidth(theme.fg("accent", `${safePhase}${elapsed}`), safeWidth, "…")];
		},
		invalidate() {},
	};
}

/** Bound expanded error/detail lines by per-line and total char budgets. */
export function boundExpandedDetailLines(
	text: string,
	options: {
		maxLines?: number;
		maxLineChars?: number;
		maxTotalChars?: number;
	} = {},
): string[] {
	const maxLines = options.maxLines ?? EXPANDED_ERROR_MAX_LINES;
	const maxLineChars = options.maxLineChars ?? EXPANDED_ERROR_LINE_MAX_CHARS;
	const maxTotalChars = options.maxTotalChars ?? EXPANDED_ERROR_TOTAL_MAX_CHARS;
	const safeText = sanitizeUntrustedTerminalText(text);
	const out: string[] = [];
	let total = 0;
	for (const raw of safeText.split(/\r?\n/)) {
		if (out.length >= maxLines || total >= maxTotalChars) break;
		const remaining = maxTotalChars - total;
		const line = boundDisplay(raw, Math.min(maxLineChars, remaining));
		out.push(line);
		total += line.length;
	}
	return out;
}

/** Bound expanded body lines before Text wrapping. */
export function boundExpandedBodyLines(
	text: string,
	options: { strategy?: "head" | "head-tail" } = {},
): string[] {
	const safeText = sanitizeUntrustedTerminalText(text);
	let limited = safeText;
	if (safeText.length > EXPANDED_BODY_MAX_CHARS) {
		if (options.strategy === "head-tail") {
			const separator = `\n${EXPANDED_BODY_MIDDLE_OMISSION}\n`;
			const contentBudget = EXPANDED_BODY_MAX_CHARS - separator.length;
			const headChars = Math.ceil(contentBudget / 2);
			const tailChars = Math.floor(contentBudget / 2);
			limited = `${safeText.slice(0, headChars)}${separator}${safeText.slice(-tailChars)}`;
		} else {
			limited = `${safeText.slice(0, EXPANDED_BODY_MAX_CHARS)}…`;
		}
	}
	return limited.split(/\r?\n/);
}

/**
 * Native fallback result for web/x search.
 * Collapsed: status + bounded preview. Expanded: answer body + status footer.
 * Partial: single accent progress line (caller may wrap with pending shell).
 */
export function renderSearchToolResult(result: SearchRenderResult, expanded: boolean, isPartial: boolean, theme: Theme, isError = false): Component {
	const details = isRecord(result.details) ? result.details : {};
	if (isPartial) {
		const startedAt = typeof details.startedAt === "number" ? details.startedAt : undefined;
		const phase = textValue(details.phase) ?? "searching";
		return renderPartialProgressLine(theme, phase, startedAt);
	}

	const ok = details.ok === false ? false : !isError && result.isError !== true;
	const sourceCount = numberValue(details.sourceCount);
	const elapsedMs = numberValue(details.elapsedMs);
	const code = textValue(details.code);
	const statusCode = numberValue(details.status);
	const error = textValue(details.error) ?? (!ok ? firstTextContent(result.content) : undefined);
	const sourceLabel = sourceCount === undefined ? undefined : plural(sourceCount, "source");
	const elapsedLabel = elapsedMs === undefined ? undefined : formatSeconds(elapsedMs);
	const tookLabel = elapsedLabel === undefined ? undefined : `Took ${elapsedLabel}`;
	const statusParts = ok
		? [tookLabel, sourceLabel].filter((p): p is string => Boolean(p))
		: [tookLabel, code ?? "failed", statusCode !== undefined ? `HTTP ${statusCode}` : undefined].filter((p): p is string => Boolean(p));
	const statusLine = theme.fg(ok ? "success" : "error", statusParts.join(" · ") || (ok ? "completed" : "failed"));

	if (!ok) {
		const lines: string[] = [];
		if (error) lines.push(theme.fg("dim", boundDisplay(error, PREVIEW_MAX_CHARS)));
		if (expanded && error && error.length > PREVIEW_MAX_CHARS) {
			for (const line of boundExpandedDetailLines(error)) {
				lines.push(theme.fg("toolOutput", line));
			}
		}
		lines.push("");
		lines.push(statusLine);
		return nativeShell(theme, "error", lines);
	}

	const answerLines = answerLinesFromContent(result.content, sourceCount);
	const answerText = answerLines.join("\n");
	const preview = collapsedContentPreview(answerText);

	if (!expanded) {
		const lines: string[] = [];
		for (const line of preview.lines) lines.push(theme.fg("dim", line));
		if (preview.omittedLines > 0) lines.push(theme.fg("muted", moreLinesLabel(preview.omittedLines)));
		lines.push("");
		lines.push(statusLine);
		return nativeShell(theme, "success", lines);
	}

	const lines: string[] = [];
	for (const line of boundExpandedBodyLines(answerText)) {
		lines.push(theme.fg("dim", line));
	}
	if (answerText) lines.push("");
	lines.push(statusLine);
	return nativeShell(theme, "success", lines);
}

export const renderWebSearchToolResult = renderSearchToolResult;

export function searchArgs(args: unknown): string {
	if (!isRecord(args)) return "";
	const parts: string[] = [];
	if (typeof args.query === "string") {
		const q = boundDisplay(args.query, QUERY_DISPLAY_MAX);
		parts.push(`"${q}"`);
	}
	if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
	return parts.join(" ");
}

function nativeSearchCall(kind: SearchPresentationKind, args: unknown, theme: Theme, context: SearchRenderContext): Component {
	const label = kind === "x" ? "x search" : "search";
	const value = isRecord(args) ? args : {};
	const query = textValue(value.query);
	const display = query ? boundDisplay(query, QUERY_DISPLAY_MAX) : "(no query)";
	const line = theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg(query ? "accent" : "error", query ? `"${display}"` : display);
	return nativeCallShell(theme, () => context.state?.fallbackStatus ?? "pending", line);
}

export function createSearchRenderers(kind: SearchPresentationKind) {
	const spec = betterTuiSpec(kind);
	return {
		renderCall(args: unknown, theme: Theme, context: SearchRenderContext) {
			if (!context.state) {
				return nativeSearchCall(kind, args, theme, context);
			}
			return presentToolCall(spec, args, theme, context as never, () => nativeSearchCall(kind, args, theme, context));
		},
		renderResult(result: SearchRenderResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: SearchRenderContext) {
			const details = isRecord(result.details) ? result.details : {};
			const ok = details.ok === false ? false : !context.isError && result.isError !== true;
			if (context.state) context.state.fallbackStatus = options.isPartial ? "pending" : ok ? "success" : "error";
			const native = () => {
				updateElapsedTimer(options.isPartial, context);
				const body = renderSearchToolResult(result, options.expanded, options.isPartial, theme, context.isError);
				// Partial progress Component is not yet boxed; wrap once with width-safe shell.
				if (options.isPartial) return nativePartialShell(body, theme);
				// Success/error already include shell via nativeShell.
				return body;
			};
			if (!context.state) return native();
			return presentToolResult(
				spec,
				result as never,
				options as never,
				theme,
				context as never,
				native,
				(attempt) => {
					if (attempt.component) updateElapsedTimer(false, context);
				},
			);
		},
	};
}
