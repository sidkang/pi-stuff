import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const COMMAND_NAME = "copy-code";
const PREVIEW_LINES = 14;
const MAX_VISIBLE_BLOCKS = 8;
const MAX_SUMMARY_LENGTH = 72;

const C_LIKE_KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"yield",
]);

const PYTHON_KEYWORDS = new Set([
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"case",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"False",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"match",
	"None",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"True",
	"try",
	"while",
	"with",
	"yield",
]);

const SHELL_KEYWORDS = new Set([
	"case",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"export",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"local",
	"readonly",
	"return",
	"select",
	"then",
	"until",
	"while",
]);

interface ExtractedCodeBlock {
	id: string;
	language: string;
	rawCode: string;
	formattedCode: string;
	summary: string;
	lineCount: number;
}

interface PreviewTheme {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

interface PreviewRenderResult {
	visualLines: string[];
	skippedCount: number;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Unknown error";
}

function assistantTextFromEntry(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (!("role" in message) || message.role !== "assistant") return undefined;
	if (!Array.isArray(message.content)) return undefined;

	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || undefined;
}

export function collectLatestTurnAssistantText(entries: SessionEntry[]): string {
	let lastUserIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if ("role" in message && message.role === "user") {
			lastUserIndex = index;
			break;
		}
	}

	const texts: string[] = [];
	for (let index = Math.max(0, lastUserIndex + 1); index < entries.length; index += 1) {
		const text = assistantTextFromEntry(entries[index]);
		if (text) texts.push(text);
	}

	return texts.join("\n\n");
}

function commonIndent(indents: string[]): string {
	if (indents.length === 0) return "";
	let prefix = indents[0];
	for (let index = 1; index < indents.length && prefix; index += 1) {
		const current = indents[index];
		let cursor = 0;
		while (cursor < prefix.length && cursor < current.length && prefix[cursor] === current[cursor]) {
			cursor += 1;
		}
		prefix = prefix.slice(0, cursor);
	}
	return prefix;
}

function stripIndent(line: string, indent: string): string {
	let cursor = 0;
	while (cursor < line.length && cursor < indent.length && line[cursor] === indent[cursor]) {
		cursor += 1;
	}
	return line.slice(cursor);
}

export function formatCodeBlock(code: string): string {
	const normalized = code.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");

	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	if (lines.length === 0) return "";

	const indents = lines
		.filter((line) => line.trim() !== "")
		.map((line) => line.match(/^[ \t]*/)?.[0] ?? "");
	const indent = commonIndent(indents);

	return lines.map((line) => (line.trim() === "" ? "" : stripIndent(line, indent))).join("\n");
}

function summarizeCode(code: string): string {
	const firstLine = code
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return "(empty block)";
	return firstLine.length > MAX_SUMMARY_LENGTH
		? `${firstLine.slice(0, MAX_SUMMARY_LENGTH - 3)}...`
		: firstLine;
}

export function extractCodeBlocks(text: string): ExtractedCodeBlock[] {
	const normalized = text.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const blocks: ExtractedCodeBlock[] = [];
	let index = 0;
	let openLanguage = "";
	let blockLines: string[] | null = null;

	for (const line of lines) {
		if (blockLines === null) {
			const openMatch = line.match(/^```([^`]*)$/);
			if (!openMatch) continue;
			openLanguage = openMatch[1]?.trim().split(/\s+/)[0] ?? "";
			blockLines = [];
			continue;
		}

		if (/^```\s*$/.test(line)) {
			index += 1;
			const rawCode = blockLines.join("\n");
			const formattedCode = formatCodeBlock(rawCode);
			blocks.push({
				id: `block-${index}`,
				language: openLanguage,
				rawCode,
				formattedCode,
				summary: summarizeCode(formattedCode),
				lineCount: formattedCode === "" ? 0 : formattedCode.split("\n").length,
			});
			blockLines = null;
			openLanguage = "";
			continue;
		}

		blockLines.push(line);
	}

	return blocks;
}

function normalizeLanguage(language: string): string {
	switch (language.trim().toLowerCase()) {
		case "cjs":
		case "javascript":
		case "js":
		case "jsx":
		case "mjs":
		case "ts":
		case "tsx":
		case "typescript":
			return "clike";
		case "json":
		case "jsonc":
			return "json";
		case "py":
		case "python":
			return "python";
		case "bash":
		case "shell":
		case "sh":
		case "zsh":
			return "shell";
		default:
			return "plain";
	}
}

function readQuotedString(line: string, start: number): number {
	const quote = line[start] ?? '"';
	let index = start + 1;
	let escaped = false;
	while (index < line.length) {
		const current = line[index] ?? "";
		index += 1;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (current === "\\") {
			escaped = true;
			continue;
		}
		if (current === quote) break;
	}
	return index;
}

function highlightCLikeLine(line: string, theme: PreviewTheme, keywords: Set<string>): string {
	let highlighted = "";
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (line.startsWith("//", index) || line.startsWith("/*", index)) {
			highlighted += theme.fg("syntaxComment", line.slice(index));
			break;
		}
		if (char === "'" || char === '"' || char === "`") {
			const end = readQuotedString(line, index);
			highlighted += theme.fg("syntaxString", line.slice(index, end));
			index = end;
			continue;
		}
		if (/\d/.test(char) && !/[\w$]/.test(line[index - 1] ?? "")) {
			const match = /^\d+(?:\.\d+)?/.exec(line.slice(index));
			if (match) {
				highlighted += theme.fg("syntaxNumber", match[0]);
				index += match[0].length;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(char)) {
			const match = /^[A-Za-z_$][\w$]*/.exec(line.slice(index));
			if (match) {
				highlighted += keywords.has(match[0]) ? theme.fg("syntaxKeyword", match[0]) : match[0];
				index += match[0].length;
				continue;
			}
		}
		if (/[+\-*/%=<>!&|^~?:]+/.test(char)) {
			highlighted += theme.fg("syntaxOperator", char);
			index += 1;
			continue;
		}
		if (/[()[\]{},.;]/.test(char)) {
			highlighted += theme.fg("syntaxPunctuation", char);
			index += 1;
			continue;
		}
		highlighted += char;
		index += 1;
	}
	return highlighted;
}

function highlightPythonLine(line: string, theme: PreviewTheme): string {
	let highlighted = "";
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === "#") {
			highlighted += theme.fg("syntaxComment", line.slice(index));
			break;
		}
		if (char === "'" || char === '"') {
			const end = readQuotedString(line, index);
			highlighted += theme.fg("syntaxString", line.slice(index, end));
			index = end;
			continue;
		}
		if (/\d/.test(char) && !/[\w$]/.test(line[index - 1] ?? "")) {
			const match = /^\d+(?:\.\d+)?/.exec(line.slice(index));
			if (match) {
				highlighted += theme.fg("syntaxNumber", match[0]);
				index += match[0].length;
				continue;
			}
		}
		if (/[A-Za-z_$]/.test(char)) {
			const match = /^[A-Za-z_$][\w$]*/.exec(line.slice(index));
			if (match) {
				highlighted += PYTHON_KEYWORDS.has(match[0]) ? theme.fg("syntaxKeyword", match[0]) : match[0];
				index += match[0].length;
				continue;
			}
		}
		if (/[+\-*/%=<>!&|:^]+/.test(char)) {
			highlighted += theme.fg("syntaxOperator", char);
			index += 1;
			continue;
		}
		if (/[()[\]{},.;]/.test(char)) {
			highlighted += theme.fg("syntaxPunctuation", char);
			index += 1;
			continue;
		}
		highlighted += char;
		index += 1;
	}
	return highlighted;
}

function highlightJsonLine(line: string, theme: PreviewTheme): string {
	let highlighted = "";
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === '"') {
			const end = readQuotedString(line, index);
			highlighted += theme.fg("syntaxString", line.slice(index, end));
			index = end;
			continue;
		}
		if (/\d/.test(char) || (char === "-" && /\d/.test(line[index + 1] ?? ""))) {
			const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(index));
			if (match) {
				highlighted += theme.fg("syntaxNumber", match[0]);
				index += match[0].length;
				continue;
			}
		}
		if (/[A-Za-z]/.test(char)) {
			const match = /^(?:true|false|null)\b/.exec(line.slice(index));
			if (match) {
				highlighted += theme.fg("syntaxKeyword", match[0]);
				index += match[0].length;
				continue;
			}
		}
		if (/[[\]{}:,]/.test(char)) {
			highlighted += theme.fg("syntaxPunctuation", char);
			index += 1;
			continue;
		}
		highlighted += char;
		index += 1;
	}
	return highlighted;
}

function highlightShellLine(line: string, theme: PreviewTheme): string {
	let highlighted = "";
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === "#") {
			highlighted += theme.fg("syntaxComment", line.slice(index));
			break;
		}
		if (char === "'" || char === '"') {
			const end = readQuotedString(line, index);
			highlighted += theme.fg("syntaxString", line.slice(index, end));
			index = end;
			continue;
		}
		if (/[A-Za-z_]/.test(char)) {
			const match = /^[A-Za-z_][\w-]*/.exec(line.slice(index));
			if (match) {
				highlighted += SHELL_KEYWORDS.has(match[0]) ? theme.fg("syntaxKeyword", match[0]) : match[0];
				index += match[0].length;
				continue;
			}
		}
		if (/[+\-*/%=<>!&|?:]+/.test(char)) {
			highlighted += theme.fg("syntaxOperator", char);
			index += 1;
			continue;
		}
		if (/[()[\]{};,]/.test(char)) {
			highlighted += theme.fg("syntaxPunctuation", char);
			index += 1;
			continue;
		}
		highlighted += char;
		index += 1;
	}
	return highlighted;
}

function highlightCodeLine(line: string, language: string, theme: PreviewTheme): string {
	switch (normalizeLanguage(language)) {
		case "clike":
			return highlightCLikeLine(line, theme, C_LIKE_KEYWORDS);
		case "json":
			return highlightJsonLine(line, theme);
		case "python":
			return highlightPythonLine(line, theme);
		case "shell":
			return highlightShellLine(line, theme);
		default:
			return line;
	}
}

function previewCodeBlock(code: string, language: string, theme: PreviewTheme, width: number): PreviewRenderResult {
	const normalized = code.replace(/\r\n?/g, "\n");
	const sourceLines = normalized.length === 0 ? [""] : normalized.split("\n");
	const visualLines: string[] = [];
	let totalVisualLines = 0;

	for (const sourceLine of sourceLines) {
		const highlighted = highlightCodeLine(sourceLine, language, theme);
		const wrapped = sourceLine === "" ? [""] : wrapTextWithAnsi(highlighted, width);
		const currentVisualLines = wrapped.length > 0 ? wrapped : [""];
		totalVisualLines += currentVisualLines.length;
		if (visualLines.length >= PREVIEW_LINES) continue;
		visualLines.push(...currentVisualLines.slice(0, PREVIEW_LINES - visualLines.length));
	}

	return {
		visualLines,
		skippedCount: Math.max(0, totalVisualLines - visualLines.length),
	};
}

function blockLabel(block: ExtractedCodeBlock, index: number): string {
	const language = block.language || "plain";
	const lines = block.lineCount === 1 ? "1 line" : `${block.lineCount} lines`;
	return `#${index + 1} ${language}  ${block.summary}  (${lines})`;
}

function boxLine(border: (text: string) => string, content: string, innerWidth: number): string {
	const safeContent = truncateToWidth(content, innerWidth, "");
	const rightPad = Math.max(0, innerWidth - visibleWidth(safeContent));
	return `${border("│")}${safeContent}${" ".repeat(rightPad)}${border("│")}`;
}

function borderLine(border: (text: string) => string, left: string, fill: string, right: string, width: number): string {
	return border(left + fill.repeat(Math.max(0, width - 2)) + right);
}

async function showCopyCodePicker(ctx: ExtensionContext, blocks: ExtractedCodeBlock[]): Promise<ExtractedCodeBlock | null> {
	const items: SelectItem[] = blocks.map((block, index) => ({
		value: block.id,
		label: blockLabel(block, index),
		description: undefined,
	}));

	return await ctx.ui.custom<ExtractedCodeBlock | null>((tui, theme: PreviewTheme, _kb, done) => {
		let selected = blocks[0];
		const list = new SelectList(
			items,
			Math.min(items.length, MAX_VISIBLE_BLOCKS),
			{
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			},
		);

		list.onSelectionChange = (item) => {
			selected = blocks.find((block) => block.id === item.value) ?? blocks[0];
			component.invalidate();
			tui.requestRender();
		};
		list.onSelect = (item) => {
			done(blocks.find((block) => block.id === item.value) ?? null);
		};
		list.onCancel = () => done(null);

		const component = {
			cachedWidth: undefined as number | undefined,
			cachedLines: undefined as string[] | undefined,
			invalidate() {
				this.cachedWidth = undefined;
				this.cachedLines = undefined;
			},
			render(width: number) {
				if (width < 4) {
					return [" ".repeat(Math.max(0, width))];
				}

				if (this.cachedLines && this.cachedWidth === width) {
					return this.cachedLines.slice();
				}

				const boxWidth = Math.max(4, Math.min(width, 120));
				const innerWidth = Math.max(1, boxWidth - 2);
				const previewHeader = `${theme.bold("Preview")} · ${selected.language || "plain"} · ${selected.lineCount || 0} lines`;
				const previewResult = previewCodeBlock(selected.formattedCode || "(empty block)", selected.language, theme, innerWidth);
				const listLines = list.render(innerWidth);
				const lines = [
					borderLine((text) => theme.fg("accent", text), "╭", "─", "╮", boxWidth),
					boxLine((text) => theme.fg("accent", text), theme.fg("accent", theme.bold("Copy Code Block")), innerWidth),
					borderLine((text) => theme.fg("accent", text), "├", "─", "┤", boxWidth),
					boxLine((text) => theme.fg("accent", text), previewHeader, innerWidth),
					...previewResult.visualLines.map((line) => boxLine((text) => theme.fg("accent", text), line, innerWidth)),
				];

				if (previewResult.skippedCount > 0) {
					lines.push(
						boxLine(
							(text) => theme.fg("accent", text),
							theme.fg("dim", `... ${previewResult.skippedCount} more wrapped lines`),
							innerWidth,
						),
					);
				}

				lines.push(
					borderLine((text) => theme.fg("accent", text), "├", "─", "┤", boxWidth),
					boxLine((text) => theme.fg("accent", text), theme.bold("Blocks"), innerWidth),
					...listLines.map((line) => boxLine((text) => theme.fg("accent", text), line, innerWidth)),
					borderLine((text) => theme.fg("accent", text), "├", "─", "┤", boxWidth),
					boxLine(
						(text) => theme.fg("accent", text),
						theme.fg("dim", "↑↓ navigate • enter copy • esc cancel"),
						innerWidth,
					),
					borderLine((text) => theme.fg("accent", text), "╰", "─", "╯", boxWidth),
				);

				this.cachedWidth = width;
				this.cachedLines = lines;
				return lines.slice();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};

		return component;
	});
}

async function copyLatestTurnCode(ctx: ExtensionContext): Promise<void> {
	const assistantText = collectLatestTurnAssistantText(ctx.sessionManager.getBranch());
	const blocks = extractCodeBlocks(assistantText);

	if (blocks.length === 0) {
		ctx.ui.notify("No code blocks found in the latest assistant turn", "warning");
		return;
	}

	const selected = await showCopyCodePicker(ctx, blocks);
	if (!selected) return;

	try {
		await copyToClipboard(selected.formattedCode);
		ctx.ui.notify(`Copied ${selected.language || "plain"} block to clipboard`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to copy code block: ${getErrorMessage(error)}`, "error");
	}
}

export default function copyCodeExtension(pi: ExtensionAPI): void {
	let registered = false;

	pi.on("session_start", async (_event, ctx) => {
		if (registered || ctx.mode !== "tui") return;
		registered = true;

		pi.registerCommand(COMMAND_NAME, {
			description: "Pick and copy a code block from the latest assistant turn",
			handler: async (_args, commandCtx) => {
				await copyLatestTurnCode(commandCtx);
			},
		});
	});
}
