import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const BETTER_FOOTER_EVENTS = {
	ready: "better-footer:ready",
	requestApi: "better-footer:request-api",
	register: "better-footer:register",
	unregister: "better-footer:unregister",
	clear: "better-footer:clear",
	refresh: "better-footer:refresh",
} as const;

export type BetterFooterSide = "left" | "right";
export type BetterFooterPosition = "before" | "core" | "after";
export type BetterFooterValue = string | string[] | null | undefined | false;

export type BetterFooterContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

export type BetterFooterDataProvider = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
};

export type BetterFooterRenderContext = {
	ctx: ExtensionContext;
	footerData: BetterFooterDataProvider;
	theme: Theme;
	width: number;
	projectName: string;
	branchName: string | null;
	sessionName: string | undefined;
	contextUsage: BetterFooterContextUsage | undefined;
	contextPercent: number | null;
	contextWindow: number;
	autoCompactEnabled: boolean;
	provider: string | undefined;
	showProvider: boolean;
	modelId: string | undefined;
	modelSupportsReasoning: boolean;
	thinkingLevel: string;
	extensionStatuses: ReadonlyMap<string, string>;
};

export type BetterFooterRenderer = BetterFooterValue | ((context: BetterFooterRenderContext) => BetterFooterValue);

export type BetterFooterItem = {
	/** Stable id. Registering the same id replaces the previous custom item. Built-in ids also require position: "core". */
	id: string;
	/** Which side of the footer receives this item. Defaults to "left". */
	side?: BetterFooterSide;
	/** Insert before/core/after the built-in side items. External items default to "after". */
	position?: BetterFooterPosition;
	/** Sort order within the side+position bucket. Lower values render first. */
	order?: number;
	/** Text, text tokens, or a render function. Return undefined/null/false to hide this item. */
	render?: BetterFooterRenderer;
	/** Hide this id. Useful for removing a built-in item such as "context". */
	hidden?: boolean;
};

export type BetterFooterApi = {
	version: 1;
	events: typeof BETTER_FOOTER_EVENTS;
	register(item: BetterFooterItem): void;
	unregister(id: string): void;
	clear(options: { prefix: string }): void;
	refresh(): void;
};

type NormalizedFooterItem = Required<Pick<BetterFooterItem, "id" | "side" | "position" | "order">> & {
	render?: BetterFooterRenderer;
	hidden: boolean;
	source: "built-in" | "custom";
};

type RenderBetterFooterOptions = {
	width: number;
	ctx: ExtensionContext;
	footerData: BetterFooterDataProvider;
	theme: Theme;
	thinkingLevel: string;
	autoCompactEnabled?: boolean;
	customItems?: Iterable<BetterFooterItem | NormalizedFooterItem>;
};

const DEFAULT_GAP = 2;
const BUILT_IN_ITEM_IDS = new Set(["project", "session", "context", "statuses", "provider", "model", "thinking"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFooterRenderer(value: unknown): value is BetterFooterRenderer {
	return typeof value === "string" || isStringArray(value) || typeof value === "function";
}

function dim(theme: Theme, text: string): string {
	return theme.fg("dim", text);
}

function projectNameFromCwd(cwd: string): string {
	const name = basename(cwd.replace(/[\\/]$/, ""));
	return name || cwd || "project";
}

function formatCompactTokenCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1_000) return Math.round(count).toString();
	if (count < 1_000_000) {
		const thousands = count / 1_000;
		const value = thousands < 10 && !Number.isInteger(thousands) ? thousands.toFixed(1) : Math.round(thousands).toString();
		return `${value}K`;
	}
	const millions = count / 1_000_000;
	const value = millions < 10 && !Number.isInteger(millions) ? millions.toFixed(1) : Math.round(millions).toString();
	return `${value}M`;
}

function formatContextPercent(
	contextUsage: BetterFooterContextUsage | undefined,
	options: { contextWindow?: number; autoCompactEnabled?: boolean } = {},
): { text: string; percent: number | null } {
	const contextWindow = contextUsage?.contextWindow ?? options.contextWindow ?? 0;
	const windowText = formatCompactTokenCount(contextWindow);
	const suffix = options.autoCompactEnabled === true ? " [A]" : "";
	const percent = contextUsage?.percent;
	if (percent === null || percent === undefined || !Number.isFinite(percent)) {
		return { text: `?/${windowText}${suffix}`, percent: null };
	}
	return { text: `${percent.toFixed(1)}%/${windowText}${suffix}`, percent };
}

function readAnsiSequenceEnd(value: string, start: number): { end: number; keep: boolean } {
	const introducer = value[start + 1];
	if (introducer === "[") {
		let index = start + 2;
		while (index < value.length) {
			const code = value.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return { end: index + 1, keep: value[index] === "m" };
			index += 1;
		}
		return { end: value.length, keep: false };
	}

	if (introducer === "]" || introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
		let index = start + 2;
		while (index < value.length) {
			if (value.charCodeAt(index) === 0x07) return { end: index + 1, keep: false };
			if (value[index] === "\x1b" && value[index + 1] === "\\") return { end: index + 2, keep: false };
			index += 1;
		}
		return { end: value.length, keep: false };
	}

	return { end: Math.min(value.length, start + 2), keep: false };
}

function sanitizeSegment(value: string): string {
	let output = "";
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === 0x1b) {
			const sequence = readAnsiSequenceEnd(value, index);
			if (sequence.keep) output += value.slice(index, sequence.end);
			index = sequence.end;
			continue;
		}
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			output += " ";
			index += 1;
			continue;
		}
		if (code < 0x20 || code === 0x7f) {
			index += 1;
			continue;
		}
		if (
			(code >= 0x80 && code <= 0x9f) ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			index += 1;
			continue;
		}
		output += value[index];
		index += 1;
	}
	return output.replace(/ +/g, " ").trim();
}

function normalizeFooterValue(value: BetterFooterValue): string[] {
	if (value === false || value === null || value === undefined) return [];
	const values = Array.isArray(value) ? value : [value];
	return values.map((item) => sanitizeSegment(String(item))).filter((item) => item.length > 0);
}

function normalizeSide(value: unknown): BetterFooterSide {
	return value === "right" ? "right" : "left";
}

function normalizePosition(value: unknown, fallback: BetterFooterPosition): BetterFooterPosition {
	return value === "before" || value === "core" || value === "after" ? value : fallback;
}

function normalizeOrder(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeFooterItem(value: unknown, fallbackPosition: BetterFooterPosition = "after"): NormalizedFooterItem | undefined {
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id.trim() : "";
	if (!id) return undefined;

	const position = normalizePosition(value.position, fallbackPosition);
	if (BUILT_IN_ITEM_IDS.has(id) && position !== "core") return undefined;

	const hidden = value.hidden === true;
	const render = value.render;
	if (!hidden && !isFooterRenderer(render)) return undefined;

	return {
		id,
		side: normalizeSide(value.side),
		position,
		order: normalizeOrder(value.order),
		render: isFooterRenderer(render) ? render : undefined,
		hidden,
		source: "custom",
	};
}

function contextPercentColor(theme: Theme, text: string, percent: number | null): string {
	if (percent === null) return dim(theme, text);
	if (percent > 90) return theme.fg("error", text);
	if (percent > 70) return theme.fg("warning", text);
	return dim(theme, text);
}

type ExtensionStatusFormatter = (text: string, theme: Theme) => string[] | undefined;

function formatPonytailStatus(text: string, theme: Theme): string[] | undefined {
	const plainText = sanitizeSegment(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
	const mode = /\b(lite|full|ultra)\b/i.exec(plainText)?.[1]?.toLowerCase();
	return mode ? [dim(theme, `🐴 ${mode}`)] : undefined;
}

const EXTENSION_STATUS_FORMATTERS: Record<string, ExtensionStatusFormatter> = {
	ponytail: formatPonytailStatus,
};

function extensionStatusSegment(id: string, text: string, theme: Theme): string[] {
	return EXTENSION_STATUS_FORMATTERS[id]?.(text, theme) ?? normalizeFooterValue(text);
}

function statusSegments(footerData: BetterFooterDataProvider, theme: Theme): string[] {
	return Array.from(footerData.getExtensionStatuses().entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([id, text]) => extensionStatusSegment(id, text, theme));
}

function builtInItems(): NormalizedFooterItem[] {
	const items: Array<Omit<NormalizedFooterItem, "source">> = [
		{
			id: "project",
			side: "left",
			position: "core",
			order: 0,
			hidden: false,
			render: ({ projectName, branchName, theme }) => dim(theme, branchName ? `${projectName} (${branchName})` : projectName),
		},
		{
			id: "session",
			side: "left",
			position: "core",
			order: 10,
			hidden: false,
			render: ({ sessionName, theme }) => (sessionName ? dim(theme, `[${sessionName}]`) : undefined),
		},
		{
			id: "context",
			side: "left",
			position: "core",
			order: 20,
			hidden: false,
			render: ({ contextUsage, contextWindow, autoCompactEnabled, theme }) => {
				const { text, percent } = formatContextPercent(contextUsage, { contextWindow, autoCompactEnabled });
				return contextPercentColor(theme, text, percent);
			},
		},
		{
			id: "statuses",
			side: "left",
			position: "after",
			order: 1000,
			hidden: false,
			render: ({ footerData, theme }) => statusSegments(footerData, theme),
		},
		{
			id: "provider",
			side: "right",
			position: "core",
			order: 20,
			hidden: false,
			render: ({ provider, showProvider, theme }) => (showProvider && provider ? dim(theme, provider) : undefined),
		},
		{
			id: "model",
			side: "right",
			position: "core",
			order: 10,
			hidden: false,
			render: ({ modelId, theme }) => (modelId ? dim(theme, modelId) : undefined),
		},
		{
			id: "thinking",
			side: "right",
			position: "core",
			order: 0,
			hidden: false,
			render: ({ modelSupportsReasoning, thinkingLevel, theme }) => (modelSupportsReasoning ? dim(theme, thinkingLevel) : undefined),
		},
	];
	return items.map((item) => ({ ...item, source: "built-in" }));
}

function effectiveItems(customItems: Iterable<BetterFooterItem | NormalizedFooterItem> | undefined): NormalizedFooterItem[] {
	const items = new Map<string, NormalizedFooterItem>();
	for (const item of builtInItems()) items.set(item.id, item);
	for (const item of customItems ?? []) {
		const normalized = normalizeFooterItem(item, "after");
		if (normalized) items.set(normalized.id, normalized);
	}
	return Array.from(items.values()).filter((item) => !item.hidden);
}

const positionRank: Record<BetterFooterPosition, number> = {
	before: 0,
	core: 1,
	after: 2,
};

function compareItems(left: NormalizedFooterItem, right: NormalizedFooterItem): number {
	return (
		positionRank[left.position] - positionRank[right.position] ||
		left.order - right.order ||
		left.id.localeCompare(right.id)
	);
}

const ANSI_SGR_PATTERN = /\x1b\[[0-?]*[ -/]*m/;

function dimPlainCustomSegments(item: NormalizedFooterItem, segments: string[], theme: Theme): string[] {
	if (item.source !== "custom") return segments;
	return segments.map((segment) => (ANSI_SGR_PATTERN.test(segment) ? segment : dim(theme, segment)));
}

function renderItem(item: NormalizedFooterItem, context: BetterFooterRenderContext): string[] {
	try {
		const value = typeof item.render === "function" ? item.render(context) : item.render;
		return dimPlainCustomSegments(item, normalizeFooterValue(value), context.theme);
	} catch {
		const safeId = sanitizeSegment(item.id).replace(/\x1b\[[0-?]*[ -/]*m/g, "") || "item";
		return normalizeFooterValue(context.theme.fg("error", `[${safeId} error]`));
	}
}

function renderSegments(side: BetterFooterSide, items: NormalizedFooterItem[], context: BetterFooterRenderContext): string[] {
	return items
		.filter((item) => item.side === side)
		.sort(compareItems)
		.flatMap((item) => renderItem(item, context));
}

function joinSegments(segments: string[]): string {
	return segments.join(" · ");
}

function accent(theme: Theme, text: string): string {
	return theme.fg("accent", text);
}

function wrapFooterSide(side: BetterFooterSide, text: string, theme: Theme): string {
	if (!text) return "";
	return side === "left"
		? `${accent(theme, "▌ ")}${text}${accent(theme, " ▶")}`
		: `${accent(theme, "◀ ")}${text}${accent(theme, " ▐")}`;
}

export function composeFooterLine(left: string, right: string, width: number, gap: number = DEFAULT_GAP): string {
	if (width <= 0) return "";

	const cleanGap = Math.max(1, gap);
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (!right) return truncateToWidth(left, width, "...");
	if (!left) {
		const shownRight = truncateToWidth(right, width, "...");
		return " ".repeat(Math.max(0, width - visibleWidth(shownRight))) + shownRight;
	}

	if (leftWidth + cleanGap + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	if (width <= cleanGap + 1) return truncateToWidth(left || right, width, "");

	const reservedRight = Math.min(rightWidth, Math.max(0, Math.floor(width * 0.45)));
	const leftBudget = Math.max(0, width - cleanGap - reservedRight);
	const shownLeft = truncateToWidth(left, leftBudget, "...");
	const availableRight = Math.max(0, width - visibleWidth(shownLeft) - cleanGap);
	const shownRight = truncateToWidth(right, availableRight, "");
	const padding = " ".repeat(Math.max(cleanGap, width - visibleWidth(shownLeft) - visibleWidth(shownRight)));

	return truncateToWidth(shownLeft + padding + shownRight, width, "");
}

function renderContext(options: RenderBetterFooterOptions): BetterFooterRenderContext {
	const contextUsage = options.ctx.getContextUsage();
	const autoCompactEnabled = options.autoCompactEnabled === true;
	const contextWindow = contextUsage?.contextWindow ?? options.ctx.model?.contextWindow ?? 0;
	const { percent } = formatContextPercent(contextUsage, { contextWindow, autoCompactEnabled });
	return {
		ctx: options.ctx,
		footerData: options.footerData,
		theme: options.theme,
		width: options.width,
		projectName: projectNameFromCwd(options.ctx.cwd),
		branchName: options.footerData.getGitBranch(),
		sessionName: options.ctx.sessionManager.getSessionName(),
		contextUsage,
		contextPercent: percent,
		contextWindow,
		autoCompactEnabled,
		provider: options.ctx.model?.provider,
		showProvider: options.footerData.getAvailableProviderCount() > 1,
		modelId: options.ctx.model?.id,
		modelSupportsReasoning: options.ctx.model?.reasoning === true,
		thinkingLevel: options.thinkingLevel || "off",
		extensionStatuses: options.footerData.getExtensionStatuses(),
	};
}

export function renderBetterFooterLine(options: RenderBetterFooterOptions): string {
	const context = renderContext(options);
	const items = effectiveItems(options.customItems);
	const left = wrapFooterSide("left", joinSegments(renderSegments("left", items, context)), context.theme);
	const right = wrapFooterSide("right", joinSegments(renderSegments("right", items, context)), context.theme);
	return composeFooterLine(left, right, options.width);
}

function idFromEventData(data: unknown): string | undefined {
	if (typeof data === "string") return data.trim() || undefined;
	if (isRecord(data) && typeof data.id === "string") return data.id.trim() || undefined;
	return undefined;
}

function clearCustomItems(customItems: Map<string, NormalizedFooterItem>, data: unknown): void {
	if (!isRecord(data) || typeof data.prefix !== "string" || data.prefix.length === 0) return;
	for (const id of customItems.keys()) {
		if (id.startsWith(data.prefix) && !BUILT_IN_ITEM_IDS.has(id)) customItems.delete(id);
	}
}

function createFooterApi(
	customItems: Map<string, NormalizedFooterItem>,
	requestRender: () => void,
): BetterFooterApi {
	return {
		version: 1,
		events: BETTER_FOOTER_EVENTS,
		register(item) {
			const normalized = normalizeFooterItem(item, "after");
			if (!normalized) return;
			customItems.set(normalized.id, normalized);
			requestRender();
		},
		unregister(id) {
			const cleanId = id.trim();
			if (!cleanId) return;
			customItems.delete(cleanId);
			requestRender();
		},
		clear(options) {
			clearCustomItems(customItems, options);
			requestRender();
		},
		refresh() {
			requestRender();
		},
	};
}

function makeFooterComponent(
	ctx: ExtensionContext,
	footerData: BetterFooterDataProvider,
	theme: Theme,
	customItems: Map<string, NormalizedFooterItem>,
	getThinkingLevel: () => string,
	dispose: () => void,
): Component & { dispose(): void } {
	return {
		invalidate() {},
		render(width: number): string[] {
			return [
				renderBetterFooterLine({
					width,
					ctx,
					footerData,
					theme,
					thinkingLevel: getThinkingLevel(),
					customItems: customItems.values(),
				}),
			];
		},
		dispose,
	};
}

export default function registerBetterFooter(pi: ExtensionAPI): void {
	const customItems = new Map<string, NormalizedFooterItem>();
	let renderRequester = () => {};
	let eventUnsubscribers: Array<() => void> = [];

	const requestRender = () => renderRequester();
	const api = createFooterApi(customItems, requestRender);
	const emitReady = () => pi.events.emit(BETTER_FOOTER_EVENTS.ready, api);

	function addEventListener(event: string, handler: (data: unknown) => void | Promise<void>): void {
		const unsubscribe = pi.events.on(event, handler);
		if (typeof unsubscribe === "function") eventUnsubscribers.push(unsubscribe);
	}

	function installEventListeners(): void {
		if (eventUnsubscribers.length > 0) return;

		addEventListener(BETTER_FOOTER_EVENTS.register, (data) => {
			const normalized = normalizeFooterItem(data, "after");
			if (!normalized) return;
			customItems.set(normalized.id, normalized);
			requestRender();
		});

		addEventListener(BETTER_FOOTER_EVENTS.unregister, (data) => {
			const id = idFromEventData(data);
			if (!id) return;
			customItems.delete(id);
			requestRender();
		});

		addEventListener(BETTER_FOOTER_EVENTS.clear, (data) => {
			clearCustomItems(customItems, data);
			requestRender();
		});

		addEventListener(BETTER_FOOTER_EVENTS.refresh, () => requestRender());
		addEventListener(BETTER_FOOTER_EVENTS.requestApi, async (data) => {
			let callback: ((api: BetterFooterApi) => unknown) | undefined;
			if (typeof data === "function") callback = data as (api: BetterFooterApi) => unknown;
			else if (isRecord(data) && typeof data.callback === "function") {
				callback = data.callback as (api: BetterFooterApi) => unknown;
			}
			if (callback) await callback(api);
		});
	}

	installEventListeners();

	pi.on("session_start", (_event, ctx) => {
		installEventListeners();
		if (ctx.mode !== "tui" || typeof ctx.ui.setFooter !== "function") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const componentRequestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(componentRequestRender);
			renderRequester = componentRequestRender;
			return makeFooterComponent(ctx, footerData, theme, customItems, () => pi.getThinkingLevel(), () => {
				unsubscribeBranch();
				if (renderRequester === componentRequestRender) renderRequester = () => {};
			});
		});

		emitReady();
	});

	pi.on("session_info_changed", () => requestRender());
	pi.on("model_select", () => requestRender());
	pi.on("thinking_level_select", () => requestRender());
	pi.on("turn_end", () => requestRender());
	pi.on("agent_end", () => requestRender());
	pi.on("session_compact", () => requestRender());

	pi.on("session_shutdown", () => {
		renderRequester = () => {};
		for (const unsubscribe of eventUnsubscribers) unsubscribe();
		eventUnsubscribers = [];
	});
}

export const __test = {
	builtInItems,
	composeFooterLine,
	effectiveItems,
	formatCompactTokenCount,
	formatContextPercent,
	normalizeFooterItem,
	projectNameFromCwd,
	renderBetterFooterLine,
	sanitizeSegment,
	visibleWidth,
};
