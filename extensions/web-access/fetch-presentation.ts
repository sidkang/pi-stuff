import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
	presentToolCall,
	presentToolResult,
	type FallbackToolStatus,
	type BetterTuiRendererSpecV1,
	type BetterTuiRendererStateV1,
	type ToolCallPresentationV1,
	type ToolResultPresentationV1,
} from "./better-tui-v1.ts";
import { isRecord } from "./responses-client.ts";
import {
	boundDisplay,
	boundExpandedBodyLines,
	boundExpandedDetailLines,
	collapsedContentPreview,
	formatSeconds,
	moreLinesLabel,
	nativeCallShell,
	nativePartialShell,
	nativeShell,
	PREVIEW_MAX_CHARS,
	renderPartialProgressLine,
	updateElapsedTimer,
} from "./presentation.ts";

type FetchRenderResult = { content?: unknown; details?: unknown; isError?: boolean };
type FetchRenderState = Record<string, unknown> & BetterTuiRendererStateV1 & {
	elapsedTimer?: ReturnType<typeof setInterval>;
	fetchStartedAt?: number;
	fetchElapsedMs?: number;
	fallbackStatus?: FallbackToolStatus;
};
type FetchRenderContext = { isError?: boolean; state?: FetchRenderState; invalidate?: () => void };

const URL_DISPLAY_MAX = 60;

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
			return item.text.trim();
		}
	}
	return undefined;
}

function displayUrl(url: string): string {
	return boundDisplay(url, URL_DISPLAY_MAX);
}

function characterCountLabel(totalChars: number | undefined, returnedChars: number | undefined, truncated: boolean): string | undefined {
	if (totalChars === undefined) return undefined;
	return truncated && returnedChars !== undefined
		? `${returnedChars} / ${totalChars} chars`
		: `${totalChars} chars`;
}

export function fetchCallPresentation(args: unknown): ToolCallPresentationV1 {
	const value = isRecord(args) ? args : {};
	const url = textValue(value.url) ?? "url";
	return {
		action: "Fetch Content",
		target: displayUrl(url),
	};
}

export function fetchResultPresentation(result: FetchRenderResult, isPartial: boolean, isError: boolean): ToolResultPresentationV1 {
	const details = isRecord(result.details) ? result.details : {};
	if (isPartial) {
		const elapsedMs = numberValue(details.elapsedMs);
		const phase = textValue(details.phase) ?? "fetching";
		return {
			status: "running",
			outcome: phase,
			metadata: elapsedMs !== undefined ? [formatSeconds(elapsedMs)] : undefined,
		};
	}
	const ok = details.ok === false ? false : !isError && result.isError !== true;
	const elapsedMs = numberValue(details.elapsedMs);
	const title = textValue(details.title);
	const totalChars = numberValue(details.totalChars);
	const returnedChars = numberValue(details.returnedChars);
	const truncated = details.truncated === true;
	const error = textValue(details.error) ?? (!ok ? firstTextContent(result.content) : undefined);
	const code = textValue(details.code);
	// Better TUI metadata: keep title bounded so protocol adapters do not dump full page titles.
	const source = textValue(details.source);
	const kernel = textValue(details.kernel);
	const metadata = [
		title ? boundDisplay(title, 80) : undefined,
		characterCountLabel(totalChars, returnedChars, truncated),
		truncated ? "truncated" : undefined,
		source,
		kernel,
		elapsedMs !== undefined ? formatSeconds(elapsedMs) : undefined,
	].filter((item): item is string => Boolean(item));
	if (!ok) {
		return {
			status: "error",
			outcome: code ?? "failed",
			metadata: metadata.length > 0 ? metadata : undefined,
			error: error ?? "fetch failed",
		};
	}
	const body = firstTextContent(result.content);
	return {
		status: "success",
		outcome: truncated ? "truncated" : "completed",
		metadata: metadata.length > 0 ? metadata : undefined,
		body: body ? [{ kind: "text", text: body, strategy: "head-tail" }] : undefined,
	};
}

/**
 * Native fallback fetch result.
 * Collapsed: compact status (chars/time/truncated) + bounded content preview — never `ok · <full title>`.
 * Expanded: status + bounded markdown body.
 */
export function renderFetchToolResult(result: FetchRenderResult, expanded: boolean, isPartial: boolean, theme: Theme, isError = false): Component {
	const details = isRecord(result.details) ? result.details : {};
	if (isPartial) {
		const startedAt = typeof details.startedAt === "number" ? details.startedAt : undefined;
		const phase = textValue(details.phase) ?? "fetching";
		return renderPartialProgressLine(theme, phase, startedAt);
	}

	const ok = details.ok === false ? false : !isError && result.isError !== true;
	const body = firstTextContent(result.content) ?? "";
	const error = textValue(details.error) ?? (!ok ? body : undefined);
	const totalChars = numberValue(details.totalChars);
	const returnedChars = numberValue(details.returnedChars);
	const truncated = details.truncated === true;
	const elapsedMs = numberValue(details.elapsedMs);
	const kernel = textValue(details.kernel);
	const source = textValue(details.source);
	const title = textValue(details.title);

	if (!ok) {
		const status = theme.fg("error", [elapsedMs !== undefined ? `Took ${formatSeconds(elapsedMs)}` : undefined, textValue(details.code) ?? "failed"].filter(Boolean).join(" · "));
		const lines: string[] = [];
		if (error) lines.push(theme.fg("dim", boundDisplay(error, PREVIEW_MAX_CHARS)));
		if (expanded && error && error.length > PREVIEW_MAX_CHARS) {
			for (const line of boundExpandedDetailLines(error)) {
				lines.push(theme.fg("toolOutput", line));
			}
		}
		lines.push("");
		lines.push(status);
		return nativeShell(theme, "error", lines);
	}

	// Compact status: prefer size/time over dumping the full page title.
	const statusParts = [
		elapsedMs !== undefined ? `Took ${formatSeconds(elapsedMs)}` : undefined,
		characterCountLabel(totalChars, returnedChars, truncated),
		truncated ? "truncated" : undefined,
		source,
		kernel,
	].filter((p): p is string => Boolean(p));
	const statusLine = theme.fg("success", statusParts.join(" · ") || "completed");
	const titleLine = title ? theme.fg("muted", boundDisplay(title, 80)) : undefined;
	const preview = collapsedContentPreview(body, { skipHeadings: true });

	if (!expanded) {
		const lines: string[] = [];
		if (titleLine) lines.push(titleLine);
		for (const line of preview.lines) lines.push(theme.fg("dim", line));
		if (preview.omittedLines > 0) lines.push(theme.fg("muted", moreLinesLabel(preview.omittedLines)));
		lines.push("");
		lines.push(statusLine);
		return nativeShell(theme, "success", lines);
	}

	const lines: string[] = [];
	if (titleLine) lines.push(titleLine);
	if (titleLine) lines.push("");
	for (const line of boundExpandedBodyLines(body, { strategy: "head-tail" })) {
		lines.push(theme.fg("toolOutput", line));
	}
	if (body) lines.push("");
	lines.push(statusLine);
	return nativeShell(theme, "success", lines);
}

function nativeFetchCall(args: unknown, theme: Theme, context: FetchRenderContext): Component {
	const value = isRecord(args) ? args : {};
	const url = textValue(value.url);
	const display = url ? displayUrl(url) : "(no URL)";
	const line = theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg(url ? "accent" : "error", display);
	return nativeCallShell(theme, () => context.state?.fallbackStatus ?? "pending", line);
}

function noteFetchStart(context: FetchRenderContext): void {
	if (!context.state || context.state.fetchStartedAt !== undefined) return;
	context.state.fetchStartedAt = Date.now();
}

function withFetchElapsed(result: FetchRenderResult, isPartial: boolean, context: FetchRenderContext): FetchRenderResult {
	if (isPartial || !context.state || context.state.fetchStartedAt === undefined) return result;
	if (context.state.fetchElapsedMs === undefined) {
		context.state.fetchElapsedMs = Math.max(0, Date.now() - context.state.fetchStartedAt);
	}
	const details = isRecord(result.details) ? result.details : {};
	if (numberValue(details.elapsedMs) !== undefined) return result;
	return {
		...result,
		details: { ...details, elapsedMs: context.state.fetchElapsedMs },
	};
}

export function createFetchRenderers() {
	const spec: BetterTuiRendererSpecV1<unknown, unknown, FetchRenderState> = {
		call(args, context) {
			noteFetchStart(context);
			return fetchCallPresentation(args);
		},
		result(result, options, context) {
			return fetchResultPresentation(withFetchElapsed(result, options.isPartial, context), options.isPartial, context.isError === true);
		},
		resultOptions: { textLines: 40, bodyLines: 50 },
	};
	return {
		renderCall(args: unknown, theme: Theme, context: FetchRenderContext) {
			noteFetchStart(context);
			if (!context.state) return nativeFetchCall(args, theme, context);
			return presentToolCall(spec, args, theme, context as never, () => nativeFetchCall(args, theme, context));
		},
		renderResult(result: FetchRenderResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: FetchRenderContext) {
			const details = isRecord(result.details) ? result.details : {};
			const ok = details.ok === false ? false : !context.isError && result.isError !== true;
			if (context.state) context.state.fallbackStatus = options.isPartial ? "pending" : ok ? "success" : "error";
			const native = () => {
				updateElapsedTimer(options.isPartial, context);
				const presented = withFetchElapsed(result, options.isPartial, context);
				const body = renderFetchToolResult(presented, options.expanded, options.isPartial, theme, context.isError);
				if (options.isPartial) return nativePartialShell(body, theme);
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

// Re-export for tests that import render path helpers.
export { Text };
