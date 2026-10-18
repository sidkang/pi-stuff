import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/**
 * Presentation Lifecycle for Codex Tools.
 *
 * Tool callers supply tool-specific semantic presentations (Protocol v1) and
 * native fallback rendering. This module owns Better TUI vs native adapter
 * selection, per-execution stickiness, safe fallback, and terminal result
 * attempt rules. Tool-specific preview/timer/path semantics stay with tools.
 */

interface AgentToolResult<TDetails = unknown> {
	content?: unknown;
	details?: TDetails;
	isError?: boolean;
}

interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

interface ToolRenderContext<TState, TArgs> {
	state: TState;
	lastComponent?: Component;
	args?: TArgs;
	toolCallId?: string;
	cwd?: string;
	executionStarted?: boolean;
	argsComplete?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	showImages?: boolean;
	isError?: boolean;
	invalidate(): void;
}

const BETTER_TUI_SYMBOL = Symbol.for("pi.better-tui.api");

export interface ToolCallPresentationV1 {
	action: string;
	target: string;
	metadata?: readonly string[];
	summary?: readonly ToolPresentationBranchV1[];
}

export type ToolPresentationBodyV1 =
	| { kind: "text"; text: string; strategy?: "head" | "tail" | "head-tail" }
	| { kind: "tree"; rows: readonly ToolPresentationBranchV1[] }
	| { kind: "diff"; unified: string }
	| { kind: "image"; alt?: string; mime?: string; width?: number; height?: number; bytes?: number }
	| { kind: "progress"; label?: string; completed?: number; total?: number };

export interface ToolPresentationBranchV1 {
	text: string;
	target?: string;
	tone?: "normal" | "dim" | "warning" | "error" | "added" | "removed";
	children?: readonly ToolPresentationBranchV1[];
}

export interface ToolResultPresentationV1 {
	status: "pending" | "running" | "success" | "error" | "muted";
	target?: string;
	outcome?: string;
	metadata?: readonly string[];
	summary?: readonly ToolPresentationBranchV1[];
	body?: readonly ToolPresentationBodyV1[];
	error?: string;
}

/** Sticky presentation adapter family for one tool execution. */
export type PresentationFamily = "better-tui" | "fallback" | "retired";

export interface BetterTuiRendererStateV1 {
	betterTui?: {
		call?: ToolCallPresentationV1;
	};
	codexToolsBetterTuiV1?: {
		call?: ToolCallPresentationV1;
		family?: PresentationFamily;
	};
}

/** Semantic presentation + Protocol v1 options supplied by a tool caller. */
export interface BetterTuiRendererSpecV1<TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1> {
	call(args: TArgs, context: ToolRenderContext<TState, TArgs>): ToolCallPresentationV1;
	result(result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, context: ToolRenderContext<TState, TArgs>): ToolResultPresentationV1;
	callOptions?: { mode?: "collapsed" | "expanded" | "partial"; width?: number; textLines?: number; diffLines?: number; treeLines?: number; bodyLines?: number };
	resultOptions?: { mode?: "collapsed" | "expanded" | "partial"; width?: number; textLines?: number; diffLines?: number; treeLines?: number; bodyLines?: number };
}

/**
 * Outcome of a terminal result attempt under the Presentation Lifecycle.
 * Callers that reconcile native call-slot state (apply_patch) use this directly.
 */
export interface PresentationResultAttempt {
	/** Better TUI result component when the sticky family is better-tui and render succeeded. */
	component?: Component;
	/** True when this attempt threw while the Better TUI adapter was still selected (family becomes retired). */
	failed: boolean;
	/** Sticky family after this attempt, if any. */
	family?: PresentationFamily;
}

interface BetterTuiToolRendererV1<TArgs, TDetails, TState extends object> {
	renderCall(args: TArgs, theme: Theme, context: ToolRenderContext<TState, TArgs>): Component;
	renderResult(result: AgentToolResult<TDetails>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext<TState, TArgs>): Component;
}

interface BetterTuiProtocolV1 {
	readonly version: "1";
	readonly createRenderer: <TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1>(
		spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
	) => BetterTuiToolRendererV1<TArgs, TDetails, TState>;
}

type SelectedRenderer =
	| { family: "fallback" }
	| { family: "retired" }
	| { family: "better-tui"; renderer: BetterTuiToolRendererV1<unknown, unknown, BetterTuiRendererStateV1> };

const renderersByExecution = new WeakMap<object, SelectedRenderer>();
const renderersByApi = new WeakMap<object, WeakMap<object, BetterTuiToolRendererV1<unknown, unknown, BetterTuiRendererStateV1>>>();

function providerV1(): { api: object; protocol: BetterTuiProtocolV1 } | undefined {
	const runtime = (globalThis as Record<symbol, unknown>)[BETTER_TUI_SYMBOL];
	if (!runtime || typeof runtime !== "object") return undefined;
	const capabilities = (runtime as { capabilities?: unknown }).capabilities;
	if (!Array.isArray(capabilities) || !capabilities.includes("presentation-v1")) return undefined;
	const protocols = (runtime as { protocols?: unknown }).protocols;
	if (!protocols || typeof protocols !== "object") return undefined;
	const protocol = (protocols as { v1?: unknown }).v1;
	if (!protocol || typeof protocol !== "object") return undefined;
	if ((protocol as { version?: unknown }).version !== "1" || typeof (protocol as { createRenderer?: unknown }).createRenderer !== "function") return undefined;
	return { api: runtime, protocol: protocol as BetterTuiProtocolV1 };
}

function rendererFor<TArgs, TDetails, TState extends object>(
	provider: { api: object; protocol: BetterTuiProtocolV1 },
	spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
): BetterTuiToolRendererV1<TArgs, TDetails, TState> {
	let bySpec = renderersByApi.get(provider.api);
	if (!bySpec) {
		bySpec = new WeakMap();
		renderersByApi.set(provider.api, bySpec);
	}
	const cached = bySpec.get(spec);
	if (cached) return cached as BetterTuiToolRendererV1<TArgs, TDetails, TState>;
	const renderer = provider.protocol.createRenderer(spec);
	bySpec.set(spec, renderer as BetterTuiToolRendererV1<unknown, unknown, BetterTuiRendererStateV1>);
	return renderer;
}

function recordFamily(state: object, family: PresentationFamily): void {
	const record = state as BetterTuiRendererStateV1;
	const current = record.codexToolsBetterTuiV1;
	if (current?.family === family) return;
	record.codexToolsBetterTuiV1 = { ...current, family };
}

function selectedFor(state: object | undefined): SelectedRenderer | undefined {
	if (!state || typeof state !== "object") return undefined;
	return renderersByExecution.get(state);
}

function selectFallback(state: object): void {
	renderersByExecution.set(state, { family: "fallback" });
	recordFamily(state, "fallback");
}

function selectRetired(state: object): void {
	renderersByExecution.set(state, { family: "retired" });
	recordFamily(state, "retired");
}

function selectBetterTui(state: object, renderer: BetterTuiToolRendererV1<unknown, unknown, BetterTuiRendererStateV1>): void {
	renderersByExecution.set(state, { family: "better-tui", renderer });
	recordFamily(state, "better-tui");
}

/** Families that permanently own native rendering for the rest of the execution. */
function isNativeStickyFamily(family: PresentationFamily | undefined): family is "fallback" | "retired" {
	return family === "fallback" || family === "retired";
}

/** Sticky presentation family for an execution state, if already chosen. */
export function presentationFamilyOf(state: object | undefined): PresentationFamily | undefined {
	const selected = selectedFor(state);
	if (selected) return selected.family;
	if (!state || typeof state !== "object") return undefined;
	return (state as BetterTuiRendererStateV1).codexToolsBetterTuiV1?.family;
}

/**
 * Attempt Better TUI call rendering under Presentation Lifecycle ownership.
 * Returns undefined when the sticky family is native fallback or Better TUI is unavailable.
 */
export function renderBetterTuiCall<TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1>(
	spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
	args: TArgs,
	theme: Theme,
	context: ToolRenderContext<TState, TArgs>,
): Component | undefined {
	const state = context.state as object | undefined;
	if (!state || typeof state !== "object") return undefined;

	const selected = selectedFor(state);
	if (isNativeStickyFamily(selected?.family)) return undefined;
	if (selected?.family === "better-tui") {
		return (selected.renderer as BetterTuiToolRendererV1<TArgs, TDetails, TState>).renderCall(args, theme, context);
	}

	// Rehydrate sticky native families from persisted state when WeakMap is cold.
	const persisted = (state as BetterTuiRendererStateV1).codexToolsBetterTuiV1?.family;
	if (isNativeStickyFamily(persisted)) {
		if (persisted === "retired") selectRetired(state);
		else selectFallback(state);
		return undefined;
	}

	try {
		const provider = providerV1();
		if (!provider) {
			selectFallback(state);
			return undefined;
		}
		const renderer = rendererFor(provider, spec);
		const component = renderer.renderCall(args, theme, context);
		selectBetterTui(state, renderer as BetterTuiToolRendererV1<unknown, unknown, BetterTuiRendererStateV1>);
		return component;
	} catch {
		selectFallback(state);
		return undefined;
	}
}

/**
 * Presentation Lifecycle call entry: choose Better TUI or native for this execution
 * and keep that family sticky for subsequent call/result renders.
 */
export function presentToolCall<TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1>(
	spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
	args: TArgs,
	theme: Theme,
	context: ToolRenderContext<TState, TArgs>,
	nativeCall: () => Component,
): Component {
	const betterTui = renderBetterTuiCall(spec, args, theme, context);
	if (betterTui) return betterTui;
	return nativeCall();
}

/**
 * Single-layer native shell for renderShell:"self" tools when Better TUI is absent.
 * Uses Pi Box padding (1x0) + status background once at ordinary widths.
 * At width <= 2, skips horizontal padding so every output row can still fit.
 * Always ANSI-safe truncates final rows to `width` (Pi TUI contract).
 */
export type FallbackToolStatus = "pending" | "success" | "error";

export function renderFallbackToolShell(
	component: Component,
	theme: Theme,
	status: FallbackToolStatus | (() => FallbackToolStatus),
): Component {
	const currentStatus = () => typeof status === "function" ? status() : status;
	const bgFn = (text: string) => {
		const value = currentStatus();
		const background = value === "pending" ? "toolPendingBg" : value === "error" ? "toolErrorBg" : "toolSuccessBg";
		return theme.bg(background, text);
	};
	const box = new Box(1, 0, bgFn);
	box.addChild(component);
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width);
			const truncationMarker = bgFn("…");
			// Box padding (1x0) needs at least 3 columns for left+content+right.
			if (safeWidth <= 2) {
				return component.render(safeWidth).map((line) => truncateToWidth(bgFn(line), safeWidth, truncationMarker));
			}
			return box.render(safeWidth).map((line) => truncateToWidth(line, safeWidth, truncationMarker));
		},
		invalidate() {
			box.invalidate();
			component.invalidate?.();
		},
	};
}

/**
 * Attempt Better TUI result rendering under Presentation Lifecycle ownership.
 * Never throws: renderer failures are reported as `{ failed: true }` so native
 * terminal fallback can own the visible status.
 */
export function attemptPresentationResult<TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1>(
	spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
	result: AgentToolResult<TDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<TState, TArgs>,
): PresentationResultAttempt {
	const state = context.state as object | undefined;
	const family = presentationFamilyOf(state);
	if (!state || typeof state !== "object") return { failed: false, family };

	let selected = selectedFor(state);
	if (!selected && isNativeStickyFamily((state as BetterTuiRendererStateV1).codexToolsBetterTuiV1?.family)) {
		const persisted = (state as BetterTuiRendererStateV1).codexToolsBetterTuiV1!.family!;
		if (persisted === "retired") selectRetired(state);
		else selectFallback(state);
		selected = selectedFor(state);
	}
	if (selected?.family !== "better-tui") {
		return { failed: false, family: selected?.family ?? family };
	}
	try {
		const component = (selected.renderer as BetterTuiToolRendererV1<TArgs, TDetails, TState>).renderResult(result, options, theme, context);
		return { component, failed: false, family: "better-tui" };
	} catch {
		// Atomic retirement: never re-enter Better TUI for this execution after a terminal throw.
		selectRetired(state);
		return { failed: true, family: "retired" };
	}
}

/**
 * Attempt Better TUI result rendering without catching. Prefer
 * `attemptPresentationResult` / `presentToolResult` at tool call sites.
 */
export function renderBetterTuiResult<TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1>(
	_spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
	result: AgentToolResult<TDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<TState, TArgs>,
): Component | undefined {
	const selected = selectedFor(context.state as object | undefined);
	if (selected?.family !== "better-tui") return undefined;
	return (selected.renderer as BetterTuiToolRendererV1<TArgs, TDetails, TState>).renderResult(result, options, theme, context);
}

/**
 * Presentation Lifecycle result entry: finish with the sticky Better TUI adapter
 * when selected, otherwise render the tool-supplied native adapter.
 *
 * `onAttempt` runs for every attempt (including successful Better TUI) so tools
 * can stop timers or other execution-scoped UI side effects without re-selecting
 * an adapter.
 */
export function presentToolResult<TArgs, TDetails = unknown, TState extends object = BetterTuiRendererStateV1>(
	spec: BetterTuiRendererSpecV1<TArgs, TDetails, TState>,
	result: AgentToolResult<TDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<TState, TArgs>,
	nativeResult: (attempt: PresentationResultAttempt) => Component,
	onAttempt?: (attempt: PresentationResultAttempt) => void,
): Component {
	const attempt = attemptPresentationResult(spec, result, options, theme, context);
	onAttempt?.(attempt);
	if (attempt.component) return attempt.component;
	return nativeResult(attempt);
}
