/**
 * /context
 *
 * Small TUI view showing what's loaded/available:
 * - extensions (best-effort from registered extension slash commands)
 * - skills
 * - project context files (AGENTS.md / CLAUDE.md)
 * - current context window usage + session totals (tokens/cost)
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";

function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
	// Deliberately fuzzy (good enough for “how big-ish is this”).
	return Math.max(0, Math.ceil(text.length / 4));
}

type ToolInventoryRow = {
	name: string;
	exposure: string;
	namespace: string;
	active: boolean;
	declared: boolean | null;
	callable: boolean;
	hidden: "unreachable" | "declaration" | "?" | "no";
};

// The root's lightweight ToolInfo stub omits these public Pi 0.99.1 fields.
// Keep this assertion narrow; typecheck.mjs separately checks the full host API.
type ToolMetadata = {
	exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
	namespace?: { name: string; description?: string };
};

// Only conventional complete declaration lists are observable here. Unknown provider
// payloads must not turn the registry's original descriptions into a pretend loadout.
function observeDeclarations(payload: unknown): Map<string, number> | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as any;
	if (!Array.isArray(p.messages) && !Array.isArray(p.input)) return null;
	if (typeof p.model !== "string") return null;
	if (p.tools !== undefined && !Array.isArray(p.tools)) return null;
	const out = new Map<string, number>();
	for (const tool of p.tools ?? []) {
		const declaration = tool?.type === "function" && tool.function ? tool.function : tool;
		if (typeof declaration?.name !== "string" ||
			!(declaration.parameters || declaration.input_schema)) return null;
		out.set(declaration.name, estimateTokens(JSON.stringify(tool)));
	}
	return out;
}

function buildToolInventory(pi: ExtensionAPI, declarations: Map<string, number> | null): ToolInventoryRow[] {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools().map((tool) => {
		const metadata = tool as typeof tool & ToolMetadata;
		const exposure = metadata.exposure!;
		const declared = declarations ? declarations.has(tool.name) : null;
		return {
			name: sanitizeDisplayText(tool.name),
			exposure: sanitizeDisplayText(exposure),
			namespace: sanitizeDisplayText(metadata.namespace?.name ?? "(none)"),
			active: active.has(tool.name),
			declared,
			callable: exposure === "codemode" || exposure === "deferred" ||
				(exposure === "direct" && active.has(tool.name)),
			hidden: exposure === "hidden" ? "unreachable" : !active.has(tool.name) ? "no" :
				declared === null ? "?" : declared ? "no" : "declaration",
		};
	});
}

function inventoryText(rows: ToolInventoryRow[]): string[] {
	return rows.map((row) => sanitizeDisplayText(
		`${row.name}: active=${row.active ? "yes" : "no"}, declared=${row.declared === null ? "?" : row.declared ? "yes" : "no"}, callable=${row.callable ? "yes" : "no"}, hidden=${row.hidden}, exposure=${row.exposure}, namespace=${row.namespace}`,
	));
}

function resultText(content: unknown): string {
	return Array.isArray(content) ? content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n") : "";
}

function withoutReadContinuationNotice(text: string, source: string,
	notice: string | null = text.match(/(?:\n\n)?\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+(?: \([^\]\n]+ limit\))?)\. Use offset=\d+ to continue\.\]$/)?.[0] ?? null): string {
	// A matching paragraph can be literal file text. Remove it only outside the
	// verified source; finalization supplies the exact notice evidenced earlier.
	if (!notice || !text.endsWith(notice) || source.startsWith(text)) return text;
	const retained = text.slice(0, -notice.length);
	return retainsDirectSkillText(source, retained) ? retained : text;
}

function retainsDirectSkillText(original: string, finalized: string): boolean {
	return !!original.trim() && !!finalized.trim() &&
		(original.startsWith(finalized) || finalized.includes(original));
}

const MAX_SKILL_EVIDENCE_BYTES = 1024 * 1024;
const NATIVE_READ_MAX_BYTES = 50 * 1024;

async function readSkillEvidence(filePath: string): Promise<string | null> {
	// A path may become a FIFO after the native read. Do not block before the
	// handle-based regular-file check; a pre-open stat leaves that replacement race.
	const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stats = await file.stat();
		if (!stats.isFile() || stats.size > MAX_SKILL_EVIDENCE_BYTES) return null;
		// A fixed buffer also bounds a file that grows after stat; never readFile
		// an unbounded replacement just to prove visibility of a small read result.
		const buffer = Buffer.alloc(MAX_SKILL_EVIDENCE_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		return size <= MAX_SKILL_EVIDENCE_BYTES ? buffer.subarray(0, size).toString("utf8") : null;
	} finally { await file.close(); }
}

function requestedSkillText(fileText: string, input: { offset?: unknown; limit?: unknown }): string | null {
	const offset = input.offset ?? 1;
	const limit = input.limit;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1 ||
		(limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1))) return null;
	const lines = fileText.split("\n");
	const start = offset - 1;
	if (start >= lines.length || Buffer.byteLength(lines[start], "utf8") > NATIVE_READ_MAX_BYTES) return null;
	return lines.slice(start, limit === undefined ? undefined : start + (limit as number)).join("\n");
}

function estimateSkillPromptTokens(name: string, description: string, filePath: string): number {
	return estimateTokens(
		[
			"  <skill>",
			`    <name>${name}</name>`,
			`    <description>${description}</description>`,
			`    <location>${filePath}</location>`,
			"  </skill>",
		].join("\n"),
	);
}

function formatTokenEstimate(tokens: number | null): string {
	return tokens === null ? "?" : `~${tokens.toLocaleString()}`;
}

function fitText(value: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(sanitizeDisplayText(value), width, "…");
}

function padText(value: string, width: number, align: "left" | "right" = "left"): string {
	const fitted = fitText(value, width);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	return align === "right" ? padding + fitted : fitted + padding;
}

function sanitizeDisplayText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeReadPath(inputPath: string, cwd: string): string {
	// Similar to pi's resolveToCwd/resolveReadPath, but simplified.
	let p = inputPath;
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
	return path.resolve(p);
}

async function estimateFileTokens(filePath: string): Promise<number | null> {
	try {
		const stats = await fs.stat(filePath);
		return stats.isFile() ? Math.ceil(stats.size / 4) : null;
	} catch {
		return null;
	}
}

function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

type SkillIndexEntry = {
	name: string;
	skillFilePath: string;
	skillDir: string;
};

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndexEntry[] {
	return pi
		.getCommands()
		.filter((c) => c.source === "skill")
		.map((c) => {
			const p = c.sourceInfo?.path ? normalizeReadPath(c.sourceInfo.path, cwd) : "";
			return {
				name: normalizeSkillName(c.name),
				skillFilePath: p,
				skillDir: p ? path.dirname(p) : "",
			};
		})
		.filter((x) => x.name && x.skillFilePath && x.skillDir);
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";
const CONTEXT_REPORT_ENTRY = "context:report";

type SkillLoadedEntryData = {
	name: string;
	path: string;
	tokens: number;
};

function getLoadedSkillsFromSession(ctx: ExtensionContext): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of ctx.sessionManager.buildContextEntries()) {
		if ((e as any)?.type !== "custom") continue;
		if ((e as any)?.customType !== SKILL_LOADED_ENTRY) continue;
		const data = (e as any)?.data as SkillLoadedEntryData | undefined;
		if (!data?.name) continue;
		const tokens = Number.isFinite(data.tokens) && data.tokens > 0 ? data.tokens : 1;
		out.set(data.name, (out.get(data.name) ?? 0) + tokens);
	}
	return out;
}

function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") {
		const n = Number(t);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	totalCost: number;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalCost = 0;
	const addUsage = (usage: any) => {
		if (!usage) return;
		input += Number(usage.input ?? 0) || 0;
		output += Number(usage.output ?? 0) || 0;
		cacheRead += Number(usage.cacheRead ?? 0) || 0;
		cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
		totalCost += extractCostTotal(usage);
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (((entry as any)?.type === "compaction" || (entry as any)?.type === "branch_summary") && (entry as any).usage) {
			addUsage((entry as any).usage);
		}
		if ((entry as any)?.type !== "message") continue;
		const msg = (entry as any)?.message;
		if (!msg || (msg.role !== "assistant" && msg.role !== "toolResult")) continue;
		addUsage(msg.usage);
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		totalCost,
	};
}

function shortenPath(p: string, cwd: string): string {
	const rp = path.resolve(p);
	const rc = path.resolve(cwd);
	if (rp === rc) return ".";
	if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
	return rp;
}

function renderUsageBar(
	theme: any,
	parts: { system: number; tools: number; convo: number; remaining: number },
	total: number,
	width: number,
): string {
	const w = Math.max(10, width);
	if (total <= 0) return "";

	const toCols = (n: number) => Math.round((n / total) * w);
	let sys = toCols(parts.system);
	let tools = toCols(parts.tools);
	let con = toCols(parts.convo);
	let rem = w - sys - tools - con;
	const used = sys + tools + con;
	if (used > w) {
		const scale = w / used;
		sys = Math.floor(sys * scale);
		tools = Math.floor(tools * scale);
		con = Math.max(0, w - sys - tools);
		rem = 0;
	} else if (rem < 0) {
		rem = 0;
	}
	// adjust rounding drift
	while (sys + tools + con + rem < w) rem++;
	while (sys + tools + con + rem > w && rem > 0) rem--;

	const block = "█";
	const sysStr = theme.fg("accent", block.repeat(sys));
	const toolsStr = theme.fg("warning", block.repeat(tools));
	const conStr = theme.fg("success", block.repeat(con));
	const remStr = theme.fg("dim", block.repeat(rem));
	return `${sysStr}${toolsStr}${conStr}${remStr}`;
}

function joinComma(items: string[]): string {
	return items.map(sanitizeDisplayText).join(", ");
}

function joinCommaStyled(items: string[], renderItem: (item: string) => string, sep: string): string {
	return items.map((item) => renderItem(sanitizeDisplayText(item))).join(sep);
}

type DetailRow = {
	kind: "skill" | "extension";
	name: string;
	activeTokens: number | null;
	fullTokens: number | null;
	status: string;
	path: string;
};

async function buildDetailRows(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	skillCmds: any[],
	extensionCmds: any[],
	declarations: Map<string, number> | null,
	promptVisibleSkills: Set<string>,
): Promise<DetailRow[]> {
	const rows: DetailRow[] = [];
	const loadedSkills = getLoadedSkillsFromSession(ctx);

	for (const c of skillCmds) {
		const name = normalizeSkillName(c.name);
		const filePath = c.sourceInfo?.path ? normalizeReadPath(c.sourceInfo.path, ctx.cwd) : "";
		const fullTokens = filePath ? await estimateFileTokens(filePath) : null;
		const promptTokens = estimateSkillPromptTokens(name, c.description ?? "", filePath);
		const loadedTokens = loadedSkills.get(name) ?? 0;
		const promptVisible = promptVisibleSkills.has(name);
		rows.push({
			kind: "skill",
			name,
			activeTokens: (promptVisible ? promptTokens : 0) + loadedTokens,
			fullTokens,
			status: loadedTokens > 0 ? "loaded" : promptVisible ? "metadata" : "command",
			path: filePath ? shortenPath(filePath, ctx.cwd) : "<unknown>",
		});
	}

	type ExtensionRowState = {
		name: string;
		path: string;
		fullPath: string | null;
		commandCount: number;
		toolCount: number;
		activeToolCount: number;
		activeToolBaseTokens: number;
	};
	const extensionRows = new Map<string, ExtensionRowState>();
	const ensureExtensionRow = (sourceInfo: any): ExtensionRowState | null => {
		const rawPath = sourceInfo?.path;
		if (!rawPath || rawPath.startsWith("<")) return null;
		const fullPath = normalizeReadPath(rawPath, ctx.cwd);
		const key = fullPath;
		let row = extensionRows.get(key);
		if (!row) {
			row = {
				name: path.basename(fullPath),
				path: shortenPath(fullPath, ctx.cwd),
				fullPath,
				commandCount: 0,
				toolCount: 0,
				activeToolCount: 0,
				activeToolBaseTokens: 0,
			};
			extensionRows.set(key, row);
		}
		return row;
	};

	for (const c of extensionCmds) {
		const row = ensureExtensionRow(c.sourceInfo);
		if (row) row.commandCount += 1;
	}

	for (const tool of pi.getAllTools() as any[]) {
		if (tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk") continue;
		const row = ensureExtensionRow(tool.sourceInfo);
		if (!row) continue;
		row.toolCount += 1;
		if (declarations?.has(tool.name)) {
			row.activeToolCount += 1;
			row.activeToolBaseTokens += declarations.get(tool.name)!;
		}
	}

	for (const row of extensionRows.values()) {
		const fullTokens = row.fullPath ? await estimateFileTokens(row.fullPath) : null;
		const status = row.toolCount > 0 ? `${declarations ? row.activeToolCount : "?"}/${row.toolCount} declared` : `${row.commandCount} cmd`;
		rows.push({
			kind: "extension",
			name: row.name,
			activeTokens: declarations ? row.activeToolBaseTokens : null,
			fullTokens,
			status,
			path: row.path,
		});
	}

	return rows;
}

type ContextViewData = {
	usage:
		| {
			// Provider-reported context usage (or Pi's own estimate before a response).
			messageTokens: number;
			contextWindow: number;
			// Same authoritative total; never add tool estimates again.
			effectiveTokens: number;
			percent: number;
			remainingTokens: number;
			systemPromptTokens: number;
			agentTokens: number;
			toolsTokens: number | null;
			activeTools: number;
		}
		| null;
	agentFiles: string[];
	extensions: string[];
	skills: string[];
	loadedSkills: string[];
	detailRows: DetailRow[];
	toolInventory: ToolInventoryRow[];
	toolObservation: string;
	session: { totalTokens: number; totalCost: number };
};

class ContextView implements Component {
	private tui: TUI;
	private theme: any;
	private onDone: () => void;
	private data: ContextViewData;
	private container: Container;
	private body: Text;
	private cachedWidth?: number;
	private viewMode: "summary" | "details" = "summary";

	constructor(tui: TUI, theme: any, data: ContextViewData, onDone: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.data = data;
		this.onDone = onDone;

		this.container = new Container();
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.container.addChild(
			new Text(
				theme.fg("accent", theme.bold("Context")) + theme.fg("dim", "  (Tab details, Esc/q/Enter close)"),
				1,
				0,
			),
		);
		this.container.addChild(new Text("", 1, 0));

		this.body = new Text("", 1, 0);
		this.container.addChild(this.body);

		this.container.addChild(new Text("", 1, 0));
		this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private rebuildDetails(width: number): void {
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const text = (s: string) => this.theme.fg("text", s);

		const lines: string[] = [];
		lines.push(muted("Detail: ") + text("active context tokens vs full file tokens") + dim("  (Tab summary)"));
		lines.push(dim("Skill active = prompt metadata + loaded skill file estimate."));
		lines.push(dim("Extension active = last observed declarations (rough); injections are not attributable."));
		lines.push("");

		const renderTable = (title: string, rows: DetailRow[]) => {
			lines.push(muted(`${title} (${rows.length})`));
			if (rows.length === 0) {
				lines.push(dim("  (none)"));
				lines.push("");
				return;
			}

			const nameWidth = Math.max(14, Math.min(28, width - 58));
			const statusWidth = 12;
			const pathWidth = Math.max(10, width - nameWidth - statusWidth - 31);
			lines.push(
				dim(
					`${padText("Name", nameWidth)} ${padText("Active", 9, "right")} ${padText("Full", 9, "right")} ${padText("Status", statusWidth)} Path`,
				),
			);
			for (const row of rows) {
				lines.push(
					`${padText(row.name, nameWidth)} ${padText(formatTokenEstimate(row.activeTokens), 9, "right")} ${padText(formatTokenEstimate(row.fullTokens), 9, "right")} ${padText(row.status, statusWidth)} ${fitText(row.path, pathWidth)}`,
				);
			}
			lines.push("");
		};

		const rows = [...this.data.detailRows].sort((a, b) => (b.activeTokens ?? 0) - (a.activeTokens ?? 0) || a.name.localeCompare(b.name));
		renderTable(
			"Skills",
			rows.filter((row) => row.kind === "skill"),
		);
		renderTable(
			"Extensions",
			rows.filter((row) => row.kind === "extension"),
		);
		lines.push(dim(this.data.toolObservation));
		lines.push(...inventoryText(this.data.toolInventory));

		this.body.setText(lines.join("\n"));
		this.cachedWidth = width;
	}

	private rebuild(width: number): void {
		if (this.viewMode === "details") {
			this.rebuildDetails(width);
			return;
		}
		const muted = (s: string) => this.theme.fg("muted", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const text = (s: string) => this.theme.fg("text", s);

		const lines: string[] = [];

		// Window + bar
		if (!this.data.usage) {
			lines.push(muted("Window: ") + dim("(unknown)"));
		} else {
			const u = this.data.usage;
			lines.push(
				muted("Window: ") +
					text(`~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`) +
					muted(`  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`),
			);

			// bar width tries to fit within the viewport
			const barWidth = Math.max(10, Math.min(36, width - 10));

			// Attribute the provider-reported total without adding estimates on top of it.
			const sysInMessages = Math.min(u.systemPromptTokens, u.messageTokens);
			const toolsInMessages = Math.min(u.toolsTokens ?? 0, Math.max(0, u.messageTokens - sysInMessages));
			const convoInMessages = Math.max(0, u.messageTokens - sysInMessages - toolsInMessages);
			const bar =
				renderUsageBar(
					this.theme,
					{
						system: sysInMessages,
						tools: toolsInMessages,
						convo: convoInMessages,
						remaining: u.remainingTokens,
					},
					u.contextWindow,
					barWidth,
				) +
				" " +
				dim("sys") +
				this.theme.fg("accent", "█") +
				" " +
				dim("tools") +
				this.theme.fg("warning", "█") +
				" " +
				dim("other (rough)") +
				this.theme.fg("success", "█") +
				" " +
				dim("free") +
				this.theme.fg("dim", "█");
			lines.push(bar);
			lines.push(dim("Breakdown is rough, non-additive attribution; window total is authoritative."));
		}

		lines.push("");

		// System prompt + tools totals (approx)
		if (this.data.usage) {
			const u = this.data.usage;
			lines.push(
				muted("System: ") +
					text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
					muted(` (AGENTS ~${u.agentTokens.toLocaleString()})`),
			);
			lines.push(
				muted("Tools: ") +
					text(`${formatTokenEstimate(u.toolsTokens)} tok`) +
					muted(` (${u.activeTools} active; ${this.data.toolObservation})`),
			);
		}

		lines.push(muted(`AGENTS (${this.data.agentFiles.length}): `) + text(this.data.agentFiles.length ? joinComma(this.data.agentFiles) : "(none)"));
		lines.push("");
		lines.push(muted(`Extensions (${this.data.extensions.length}): `) + text(this.data.extensions.length ? joinComma(this.data.extensions) : "(none)"));

		const loaded = new Set(this.data.loadedSkills);
		const skillsRendered = this.data.skills.length
			? joinCommaStyled(
					this.data.skills,
					(name) => (loaded.has(name) ? this.theme.fg("success", name) : this.theme.fg("muted", name)),
					this.theme.fg("muted", ", "),
				)
			: "(none)";
		lines.push(muted(`Skills (${this.data.skills.length}): `) + skillsRendered);
		lines.push("");
		lines.push(
			muted("Session: ") +
				text(`${this.data.session.totalTokens.toLocaleString()} tokens`) +
				muted(" · ") +
				text(formatUsd(this.data.session.totalCost)),
		);

		this.body.setText(lines.join("\n"));
		this.cachedWidth = width;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.tab)) {
			this.viewMode = this.viewMode === "summary" ? "details" : "summary";
			this.cachedWidth = undefined;
			this.invalidate();
			return;
		}

		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			data.toLowerCase() === "q" ||
			data === "\r"
		) {
			this.onDone();
			return;
		}
	}

	invalidate(): void {
		this.container.invalidate();
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) this.rebuild(width);
		return this.container.render(width);
	}
}

export default function contextExtension(pi: ExtensionAPI) {
	type Candidate = {
		toolCallId: string;
		resultId: string;
		skill: SkillIndexEntry;
		text: string;
		continuationNotice: string | null;
		nested: boolean;
		nestedSucceeded: boolean;
	};
	let candidates: Candidate[] = [];
	let generation = 0;
	let observed: { fingerprint: string; declarations: Map<string, number> | null } | null = null;
	const fingerprint = (ctx: ExtensionContext) => JSON.stringify([pi.getActiveTools(), pi.getAllTools(), pi.getSettings?.(), ctx.model?.provider, ctx.model?.id]);
	const clear = () => { generation++; candidates = []; observed = null; };
	pi.on("session_start", clear);
	pi.on("session_before_switch", clear);
	pi.on("session_before_fork", clear);
	pi.on("session_tree", clear);
	pi.on("session_compact", clear);
	pi.on("session_shutdown", clear);
	const clearPending = () => { generation++; candidates = []; };
	pi.on("agent_end", clearPending);
	pi.on("before_provider_request", (event, ctx) => {
		observed = { fingerprint: fingerprint(ctx), declarations: observeDeclarations(event.payload) };
	});

	const recordSkillLoad = (entry: SkillIndexEntry, tokens: number) => {
		pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, {
			name: entry.name,
			path: entry.skillFilePath,
			tokens: Math.max(1, tokens),
		});
	};

	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		const currentGeneration = generation;
		if (event.toolName !== "read" || event.isError) return;
		const input = event.input as { path?: unknown; offset?: unknown; limit?: unknown } | undefined;
		const p = typeof input?.path === "string" ? input.path : "";
		if (!p) return;
		const abs = normalizeReadPath(p, ctx.cwd);
		const skill = buildSkillIndex(pi, ctx.cwd).find((entry) => abs === entry.skillFilePath);
		if (!skill) return;
		let text = resultText(event.content);
		let continuationNotice: string | null = null;
		if (!text || text.length > 1024 * 1024) return;
		try {
			const fileText = await readSkillEvidence(abs);
			if (fileText === null) return;
			if (event.parentToolCallId) {
				// Nested reads still need the complete file and their own final success.
				if (fileText !== text) return;
			} else {
				const requested = requestedSkillText(fileText, input ?? {});
				if (requested === null) return;
				const retained = withoutReadContinuationNotice(text, requested);
				continuationNotice = text.slice(retained.length) || null;
				text = retained;
				// Equality with an earlier handler's output is not file evidence.
				// Native no-content diagnostics and unrelated early redactions fail here.
				if (!text.trim() || !requested.startsWith(text)) return;
			}
		} catch { return; }
		if (currentGeneration !== generation) return;
		// Conservative per-turn bounds. Overflow loses evidence, never creates loads.
		if (candidates.length >= 64 || candidates.reduce((n, item) => n + item.text.length + (item.continuationNotice?.length ?? 0), 0) +
			text.length + (continuationNotice?.length ?? 0) > 1024 * 1024) return;
		candidates.push({ toolCallId: event.toolCallId, resultId: event.parentToolCallId ?? event.toolCallId,
			skill, text, continuationNotice, nested: !!event.parentToolCallId, nestedSucceeded: false });
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "read" || !event.parentToolCallId) return;
		// Nested execution ends after all tool_result rewrites. The successful
		// catching parent is not evidence that the read itself succeeded.
		for (const item of candidates) {
			if (item.nested && item.toolCallId === event.toolCallId && item.resultId === event.parentToolCallId) {
				item.nestedSucceeded = !event.isError && resultText(event.result?.content).includes(item.text);
			}
		}
	});

	pi.on("turn_end", (event) => {
		// message_end can still replace results before they are persisted. turn_end
		// supplies finalized top-level results, never the private nested results.
		const pending = candidates;
		clearPending();
		for (const message of event.toolResults) {
			const matches = pending.filter((item) => item.resultId === message.toolCallId);
			if (message.isError) continue;
			const text = resultText(message.content);
			const recorded = new Set<string>();
			for (const item of matches) {
				if (recorded.has(item.skill.skillFilePath)) continue;
				const retained = item.nested ? item.text : withoutReadContinuationNotice(text, item.text, item.continuationNotice);
				const visible = item.nested
					? item.nestedSucceeded && text.includes(item.text)
					: message.toolName === "read" && retainsDirectSkillText(item.text, retained);
				if (visible) {
					recordSkillLoad(item.skill, estimateTokens(retained));
					recorded.add(item.skill.skillFilePath);
				}
			}
		}
	});

	pi.on("message_end", (event: any, ctx: ExtensionContext) => {
		const message = event?.message;
		if (message?.role !== "user") return;
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
				: "";
		const match = /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>/.exec(text);
		if (!match) return;
		const skill = buildSkillIndex(pi, ctx.cwd).find(
			(entry) => entry.name === match[1] && entry.skillFilePath === normalizeReadPath(match[2], ctx.cwd),
		);
		if (skill) recordSkillLoad(skill, estimateTokens(match[0]));
	});

	pi.registerCommand("context", {
		description: "Show loaded context overview",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const promptOptions = ctx.getSystemPromptOptions();
			const commands = pi.getCommands();
			const extensionCmds = commands.filter((c) => c.source === "extension");
			const skillCmds = commands.filter((c) => c.source === "skill");
			const allTools = pi.getAllTools();

			const extensionPaths = new Set<string>();
			for (const c of extensionCmds) {
				extensionPaths.add(c.sourceInfo?.path ?? "<unknown>");
			}
			for (const tool of allTools as any[]) {
				if (tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk") continue;
				const p = tool.sourceInfo?.path;
				if (p && !p.startsWith("<")) extensionPaths.add(p);
			}
			const extensionFiles = [...extensionPaths]
				.map((p) => (p === "<unknown>" || p.startsWith("<") ? p : path.basename(p)))
				.sort((a, b) => a.localeCompare(b));

			const skills = skillCmds
				.map((c) => normalizeSkillName(c.name))
				.sort((a, b) => a.localeCompare(b));

			const agentFiles = promptOptions.contextFiles ?? [];
			const agentFilePaths = agentFiles.map((file) => shortenPath(file.path, ctx.cwd));
			const agentTokens = agentFiles.reduce((total, file) => total + estimateTokens(file.content), 0);

			const systemPrompt = ctx.getSystemPrompt();
			const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;

			const usage = ctx.getContextUsage();
			const usageKnown = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens);
			const messageTokens = usageKnown ? Math.max(0, usage.tokens as number) : 0;
			const ctxWindow = usage?.contextWindow ?? 0;

			// Tool definitions are already included in provider-reported usage. This separate
			// estimate is only for an approximate breakdown and is not added to the window total.
			const activeToolNames = pi.getActiveTools();
			const declarations = observed?.fingerprint === fingerprint(ctx) ? observed.declarations : null;
			const toolsTokens = declarations ? [...declarations.values()].reduce((a, b) => a + b, 0) : null;
			const toolInventory = buildToolInventory(pi, declarations);
			const toolObservation = declarations ? "last request observed; rough serialized declarations" : "effective declarations unobserved/changed";

			const effectiveTokens = messageTokens;
			const percent = usageKnown
				? typeof usage?.percent === "number" && Number.isFinite(usage.percent)
					? usage.percent
					: ctxWindow > 0 ? (effectiveTokens / ctxWindow) * 100 : 0
				: 0;
			const remainingTokens = ctxWindow > 0 ? Math.max(0, ctxWindow - effectiveTokens) : 0;
			const promptHasRead = !promptOptions.selectedTools || promptOptions.selectedTools.includes("read");
			const promptVisibleSkills = new Set<string>(
				promptHasRead
					? (promptOptions.skills ?? [])
						.filter((skill: any) => skill.disableModelInvocation !== true)
						.map((skill: any) => skill.name)
					: [],
			);

			const sessionUsage = sumSessionUsage(ctx);

			const makePlainText = () => {
				const lines: string[] = [];
				lines.push("Context");
				if (usageKnown) {
					lines.push(
						`Window: ~${effectiveTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} (${percent.toFixed(1)}% used, ~${remainingTokens.toLocaleString()} left)`,
					);
				} else {
					lines.push("Window: (unknown)");
				}
				lines.push(`System: ~${systemPromptTokens.toLocaleString()} tok (AGENTS ~${agentTokens.toLocaleString()})`);
				lines.push(`Tools: ${formatTokenEstimate(toolsTokens)} tok (${activeToolNames.length} active; ${toolObservation})`);
				lines.push("Breakdown: rough, not additive; provider window total is authoritative.");
				lines.push(...inventoryText(toolInventory));
				lines.push(`AGENTS: ${agentFilePaths.length ? joinComma(agentFilePaths) : "(none)"}`);
				lines.push(`Extensions (${extensionFiles.length}): ${extensionFiles.length ? joinComma(extensionFiles) : "(none)"}`);
				lines.push(`Skills (${skills.length}): ${skills.length ? joinComma(skills) : "(none)"}`);
				lines.push(`Loaded skills: ${joinComma([...getLoadedSkillsFromSession(ctx).keys()]) || "(none)"}`);
				lines.push(`Session: ${sessionUsage.totalTokens.toLocaleString()} tokens · ${formatUsd(sessionUsage.totalCost)}`);
				return lines.join("\n");
			};

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				pi.appendEntry(CONTEXT_REPORT_ENTRY, { content: makePlainText(), mode: ctx.mode, toolInventory, toolObservation });
				return;
			}

			const detailRows = await buildDetailRows(
				pi,
				ctx,
				skillCmds,
				extensionCmds,
				declarations,
				promptVisibleSkills,
			);

			const loadedSkills = Array.from(getLoadedSkillsFromSession(ctx).keys()).sort((a, b) => a.localeCompare(b));

			const viewData: ContextViewData = {
				usage: usageKnown
					? {
						messageTokens,
						contextWindow: ctxWindow,
						effectiveTokens,
						percent,
						remainingTokens,
						systemPromptTokens,
						agentTokens,
						toolsTokens,
						activeTools: activeToolNames.length,
					}
					: null,
				agentFiles: agentFilePaths,
				extensions: extensionFiles,
				skills,
				loadedSkills,
				detailRows,
				toolInventory,
				toolObservation,
				session: { totalTokens: sessionUsage.totalTokens, totalCost: sessionUsage.totalCost },
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return new ContextView(tui, theme, viewData, done);
			});
		},
	});
}

export const __test = {
	observeDeclarations,
	buildToolInventory,
	estimateTokens,
	fitText,
	getLoadedSkillsFromSession,
	sanitizeDisplayText,
	sumSessionUsage,
};
