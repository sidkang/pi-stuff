import { keyHint, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { parseApplyPatch } from "./apply-patch-parser.ts";
import { computeApplyPatchPreview, type ApplyPatchPreview, type ApplyPatchResult } from "./apply-patch.ts";
import {
	attemptPresentationResult,
	presentationFamilyOf,
	presentToolCall,
	type BetterTuiRendererSpecV1,
	type BetterTuiRendererStateV1,
	type ToolCallPresentationV1,
	type ToolResultPresentationV1,
} from "./better-tui-v1.ts";

const MAX_RENDER_CHARS = 48_000;

type Preview = ApplyPatchPreview | { error: string };

export interface ApplyPatchRenderState extends BetterTuiRendererStateV1 {
	callComponent?: ApplyPatchCallRenderComponent;
}

interface ApplyPatchCallRenderComponent extends Box {
	preview?: Preview;
	previewArgsKey?: string;
	previewPending?: boolean;
	previewPendingArgsKey?: string;
	previewGeneration?: number;
	settledArgsKey?: string;
	settledError?: boolean;
}

function bounded(text: string): string {
	if (text.length <= MAX_RENDER_CHARS) return text;
	return `${text.slice(0, MAX_RENDER_CHARS)}\n[diff truncated]`;
}

function pathsFromArgs(args: unknown): string[] {
	if (!args || typeof args !== "object" || Array.isArray(args) || typeof (args as { input?: unknown }).input !== "string") return [];
	try {
		const parsed = parseApplyPatch((args as { input: string }).input);
		return [...new Set(parsed.actions.flatMap((action) => [action.path, action.moveTo].filter((path): path is string => Boolean(path))))];
	} catch {
		// During streaming, the envelope is commonly incomplete. Header extraction is intentionally best-effort.
		return [...new Set(
			((args as { input: string }).input.match(/^\*\*\* (?:Add|Update|Delete) File:\s*.+$/gm) ?? [])
				.map((line) => line.replace(/^\*\*\* (?:Add|Update|Delete) File:\s*/, "").trim())
				.filter(Boolean),
		)];
	}
}

function patchIdentity(paths: readonly string[]): Pick<ToolCallPresentationV1, "target" | "summary"> {
	if (paths.length === 0) return { target: "workspace" };
	if (paths.length === 1) return { target: paths[0]! };
	return {
		target: `${paths.length} files`,
		summary: paths.map((path) => ({ text: path })),
	};
}

export function applyPatchCallPresentation(args: unknown): ToolCallPresentationV1 {
	return { action: "Patch", ...patchIdentity(pathsFromArgs(args)) };
}

function safeLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…");
}

function hunkCount(count: number): string {
	return `${count} hunk${count === 1 ? "" : "s"}`;
}

function alreadySatisfiedSummary(count: number): string {
	return `Patch already satisfied: ${hunkCount(count)} required no change.`;
}

function mixedNoopSummary(count: number): string {
	return `${hunkCount(count)} already satisfied.`;
}

function boundedComponent(lines: string[]): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			return lines.flatMap((line) =>
				line.split("\n").flatMap((logicalLine) => {
					const wrapped = logicalLine === "" ? [""] : wrapTextWithAnsi(logicalLine, safeWidth);
					return wrapped.map((row) => safeLine(row, safeWidth));
				}),
			);
		},
	};
}

function previewKey(args: unknown, cwd: string): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args) || typeof (args as { input?: unknown }).input !== "string") return undefined;
	return `${cwd}\0${(args as { input: string }).input}`;
}

function createApplyPatchCallRenderComponent(): ApplyPatchCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as Preview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		previewPendingArgsKey: undefined as string | undefined,
		settledError: false,
	}) as ApplyPatchCallRenderComponent;
}

function getApplyPatchCallRenderComponent(state: ApplyPatchRenderState, lastComponent: unknown): ApplyPatchCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as ApplyPatchCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) return state.callComponent;
	const component = createApplyPatchCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getHeaderBg(preview: Preview | undefined, settledError: boolean | undefined, theme: Theme): (text: string) => string {
	if (preview) {
		if ("error" in preview) return (text: string) => theme.bg("toolErrorBg", text);
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolPendingBg", text);
}

function formatHeader(args: unknown, preview: Preview | undefined, theme: Theme): string {
	const paths = preview && !("error" in preview)
		? [...new Set([...preview.files, ...preview.noops.map((noop) => noop.path)])]
		: pathsFromArgs(args);
	const suffix = paths.length > 0 ? ` ${theme.fg("dim", paths.join(", "))}` : "";
	return `${theme.fg("toolTitle", theme.bold("apply_patch"))}${suffix}`;
}

function previewBody(preview: Preview | undefined, theme: Theme): string {
	if (!preview) return "";
	return "error" in preview
		? theme.fg("error", preview.error)
		: preview.diff
			? `${renderDiff(bounded(preview.diff))}${preview.noops.length > 0 ? `\n\n${theme.fg("muted", mixedNoopSummary(preview.noops.length))}` : ""}`
			: preview.noops.length > 0
				? theme.fg("success", alreadySatisfiedSummary(preview.noops.length))
				: "";
}

function buildCallComponent(component: ApplyPatchCallRenderComponent, args: unknown, theme: Theme): ApplyPatchCallRenderComponent {
	component.setBgFn(getHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatHeader(args, component.preview, theme), 0, 0));
	const body = previewBody(component.preview, theme);
	if (!body) return component;
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setPreview(component: ApplyPatchCallRenderComponent, preview: Preview, argsKey: string | undefined): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview ? current.error !== preview.error : "error" in current !== "error" in preview) ||
		(!("error" in current) && ! ("error" in preview) &&
			(current.diff !== preview.diff || current.patch !== preview.patch || current.firstChangedLine !== preview.firstChangedLine || current.files.join("\0") !== preview.files.join("\0") || JSON.stringify(current.noops) !== JSON.stringify(preview.noops)));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	component.previewPendingArgsKey = undefined;
	return changed;
}

function clearPreview(component: ApplyPatchCallRenderComponent): void {
	component.preview = undefined;
	component.previewPending = false;
	component.previewPendingArgsKey = undefined;
}

function requestPreview(
	component: ApplyPatchCallRenderComponent,
	args: unknown,
	argsKey: string | undefined,
	cwd: string,
	argsComplete: boolean,
	invalidate: () => void,
	allowHostPreview: boolean,
): void {
	if (!argsComplete || !argsKey || component.preview || component.previewPendingArgsKey === argsKey || component.settledArgsKey === argsKey) return;
	// Host sessions keep the existing async Host filesystem preview.
	// Authoritative Sandbox sessions use lexical path-list only so renderCall
	// never drives Host workspace I/O.
	if (!allowHostPreview) {
		const paths = pathsFromArgs(args);
		component.previewPending = false;
		component.previewPendingArgsKey = undefined;
		setPreview(component, {
			files: paths,
			noops: [],
			diff: "",
			patch: "",
		}, argsKey);
		invalidate();
		return;
	}
	const generation = (component.previewGeneration ?? 0) + 1;
	component.previewGeneration = generation;
	component.previewPending = true;
	component.previewPendingArgsKey = argsKey;
	const input = args && typeof args === "object" && !Array.isArray(args) && typeof (args as { input?: unknown }).input === "string"
		? (args as { input: string }).input
		: "";
	void computeApplyPatchPreview(input, { cwd }).then((preview) => {
		if (component.previewGeneration !== generation || component.settledArgsKey === argsKey) return;
		if (setPreview(component, preview, argsKey)) invalidate();
	}).catch((error: unknown) => {
		if (component.previewGeneration !== generation || component.settledArgsKey === argsKey) return;
		const message = error instanceof Error ? error.message : String(error);
		if (setPreview(component, { error: message }, argsKey)) invalidate();
	});
}

export function renderApplyPatchCall(args: unknown, theme: Theme, context?: {
	cwd: string;
	argsComplete: boolean;
	invalidate: () => void;
	lastComponent?: unknown;
	state?: ApplyPatchRenderState;
	/** Default true. Authoritative Sandbox sessions set false to avoid Host I/O. */
	allowHostPreview?: boolean;
}): Component {
	if (!context?.state) return new Text(formatHeader(args, undefined, theme), 0, 0);
	const component = getApplyPatchCallRenderComponent(context.state, context.lastComponent);
	const key = previewKey(args, context.cwd);
	if (component.previewArgsKey !== key) {
		component.preview = undefined;
		component.previewArgsKey = key;
		component.previewPending = false;
		component.previewPendingArgsKey = undefined;
		component.previewGeneration = (component.previewGeneration ?? 0) + 1;
		component.settledArgsKey = undefined;
		component.settledError = false;
	}
	return presentToolCall(APPLY_PATCH_BETTER_TUI_SPEC, args, theme, context as never, () => {
		// Retired executions stay native without reopening Host preview I/O: the terminal
		// result already owns status after a Better TUI result throw.
		if (presentationFamilyOf(context.state) !== "retired") {
			requestPreview(
				component,
				args,
				key,
				context.cwd,
				context.argsComplete,
				context.invalidate,
				context.allowHostPreview !== false,
			);
		}
		return buildCallComponent(component, args, theme);
	});
}

function resultText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function resultDetails(result: { details?: unknown }): ApplyPatchResult | undefined {
	return result.details && typeof result.details === "object" ? result.details as ApplyPatchResult : undefined;
}

export function applyPatchPresentation(result: { content?: unknown; details?: unknown }, isPartial: boolean, isError: boolean): ToolResultPresentationV1 {
	if (isPartial) return { status: "running", outcome: "applying" };
	const details = resultDetails(result);
	if (isError) return { status: "error", outcome: "failed", error: resultText(result) || "apply_patch failed" };
	const changed = details?.changedFiles?.length ?? details?.files?.length ?? 0;
	const noops = details?.noops?.length ?? 0;
	const paths = details
		? [...new Set([
			...(details.changedFiles ?? details.files?.map((file) => file.path) ?? []),
			...(details.noops ?? []).map((noop) => noop.path),
		])]
		: [];
	const identity = patchIdentity(paths);
	const body = details?.diff ? [{ kind: "diff" as const, unified: bounded(details.diff) }] : undefined;
	return {
		status: "success",
		...(details && paths.length > 0 ? { target: identity.target, summary: identity.summary ?? [] } : {}),
		outcome: changed > 0 ? "applied" : "no changes",
		metadata: noops > 0 ? [`${hunkCount(noops)} already satisfied`] : undefined,
		body,
	};
}

const APPLY_PATCH_BETTER_TUI_SPEC: BetterTuiRendererSpecV1<unknown, unknown, ApplyPatchRenderState> = {
	call(args) {
		return applyPatchCallPresentation(args);
	},
	result(result, options, context) {
		return applyPatchPresentation(result, options.isPartial, context.isError === true);
	},
	resultOptions: { diffLines: 80, bodyLines: 100 },
};

function emptyResultComponent(): Container {
	return new Container();
}

function errorOutput(result: { content?: unknown }, theme: Theme): string {
	const text = resultText(result);
	return theme.fg("error", "apply_patch failed") + (text ? `\n${theme.fg("error", text)}` : "");
}

export function renderApplyPatchResult(
	result: { content?: unknown; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { isError?: boolean; args?: unknown; cwd?: string; state?: ApplyPatchRenderState; lastComponent?: unknown },
): Component {
	// Presentation Lifecycle owns Better TUI selection / failure; patch-specific
	// call-slot reconciliation and native status remain local to apply_patch.
	const betterTui = context.state
		? attemptPresentationResult(APPLY_PATCH_BETTER_TUI_SPEC, result, options as never, theme, context as never)
		: { failed: false as const, family: undefined };

	if (options.isPartial) {
		if (betterTui.component) return betterTui.component;
		return new Text(theme.fg("muted", "Applying patch…"), 0, 0);
	}

	const state = context.state;
	const retiredBetterTuiCall = presentationFamilyOf(state) === "retired";
	const callComponent = retiredBetterTuiCall ? undefined : state?.callComponent;
	const details = resultDetails(result);
	const isError = context.isError === true;
	let output: string | undefined;

	if (callComponent) {
		const key = context.cwd && context.args ? previewKey(context.args, context.cwd) : callComponent.previewArgsKey;
		callComponent.previewGeneration = (callComponent.previewGeneration ?? 0) + 1;
		callComponent.settledArgsKey = key;
		if (isError) {
			if (betterTui.component || betterTui.failed) {
				// A successful Better TUI result owns the error. If it failed after
				// hiding the call, the standalone result fallback owns it instead.
				clearPreview(callComponent);
			} else {
				const error = resultText(result) || "apply_patch failed";
				setPreview(callComponent, { error }, key);
			}
		} else if (betterTui.failed) {
			// A failed result renderer may already have hidden the call. Keep the
			// terminal fallback as the only visible status after a later redraw.
			clearPreview(callComponent);
		} else if (typeof details?.diff === "string") {
			setPreview(callComponent, {
				diff: details.diff,
				patch: details.patch ?? "",
				files: details.changedFiles ?? details.files?.map((file) => file.path) ?? [],
				noops: details.noops ?? [],
				firstChangedLine: details.firstChangedLine,
			}, key);
		}
		if (callComponent.settledError !== isError) callComponent.settledError = isError;
		buildCallComponent(callComponent, context.args, theme);
	}

	if (betterTui.component) return betterTui.component;

	if (betterTui.failed || !callComponent || presentationFamilyOf(state) === "retired") {
		if (isError) {
			output = errorOutput(result, theme);
		} else if (details?.diff) {
			const noopText = (details.noops?.length ?? 0) > 0 ? ` ${mixedNoopSummary(details.noops.length)}` : "";
			output = options.expanded
				? `${renderDiff(bounded(details.diff))}${noopText ? `\n\n${theme.fg("muted", noopText.trim())}` : ""}`
				: theme.fg("success", `Applied patch to ${(details.changedFiles ?? []).length} file${(details.changedFiles ?? []).length === 1 ? "" : "s"}`) + theme.fg("muted", `${noopText} ${keyHint("app.tools.expand", "to view diff")}`);
		} else if ((details?.noops?.length ?? 0) > 0) {
			output = theme.fg("success", alreadySatisfiedSummary(details!.noops.length));
		}
	}

	if (!output) return emptyResultComponent();
	return boundedComponent([output]);
}

export function applyPatchRenderWidth(text: string, width: number): string {
	return safeLine(text, Math.max(1, width));
}

export function applyPatchVisibleWidth(text: string): number {
	return visibleWidth(text);
}
