export type PatchActionKind = "add" | "update" | "delete";

export interface PatchHunk {
	lines: string[];
	section?: string;
	endOfFile?: boolean;
}

export interface PatchAction {
	kind: PatchActionKind;
	path: string;
	moveTo?: string;
	hunks: PatchHunk[];
}

export interface ParsedPatch {
	actions: PatchAction[];
}

function normalizePatchText(input: string): string[] {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function parseHeader(line: string): { kind: PatchActionKind; path: string } | undefined {
	const match = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
	if (!match) return undefined;
	const path = match[2]!.trim();
	if (!path) throw new Error("Patch file header is missing a path.");
	return { kind: match[1]!.toLowerCase() as PatchActionKind, path };
}

function ensurePatchLine(action: PatchAction, line: string): void {
	if (line === "\\ No newline at end of file") {
		throw new Error("apply_patch does not support the no-newline marker; express the target text without that marker.");
	}
	if (line.startsWith("*** ")) throw new Error(`Unexpected patch directive in ${action.path}: ${line}`);
	const marker = line[0];
	if (action.kind === "add" && marker !== "+") {
		throw new Error(`Add File patch lines must start with '+': ${action.path}`);
	}
	if (action.kind === "delete" && marker !== "-" && marker !== " ") {
		throw new Error(`Delete File patch lines must start with '-' or space: ${action.path}`);
	}
	if (action.kind === "update" && marker !== "+" && marker !== "-" && marker !== " ") {
		throw new Error(`Update File patch lines must start with '+', '-', or space: ${action.path}`);
	}
}

export function parseApplyPatch(input: string): ParsedPatch {
	if (typeof input !== "string" || input.trim().length === 0) throw new Error("apply_patch input must be a non-empty string.");
	const lines = normalizePatchText(input);
	let index = 0;
	while (index < lines.length && lines[index]!.trim() === "") index++;
	if (lines[index] !== "*** Begin Patch") throw new Error("Patch must start with '*** Begin Patch'.");
	index++;

	const actions: PatchAction[] = [];
	let sawEnd = false;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line === "*** End Patch") {
			sawEnd = true;
			index++;
			break;
		}
		const header = parseHeader(line);
		if (!header) throw new Error(`Expected patch file header at line ${index + 1}.`);
		const action: PatchAction = { kind: header.kind, path: header.path, hunks: [] };
		let current: PatchHunk | undefined;
		index++;
		while (index < lines.length) {
			const bodyLine = lines[index]!;
			if (bodyLine === "*** End Patch" || parseHeader(bodyLine)) break;
			if (bodyLine === "*** End of File") {
				if (action.kind !== "update") throw new Error(`'*** End of File' is valid only in Update File patches: ${action.path}`);
				if (!current || current.lines.length === 0) throw new Error(`'*** End of File' must terminate an update hunk with at least one patch line: ${action.path}`);
				current.endOfFile = true;
				action.hunks.push(current);
				current = undefined;
				index++;
				break;
			}
			if (bodyLine.startsWith("*** Move to:")) {
				if (action.kind !== "update") throw new Error("Only Update File patches may include '*** Move to:'.");
				if (current || action.hunks.length > 0) throw new Error(`'*** Move to:' must appear before all hunks in Update File patches: ${action.path}`);
				if (action.moveTo) throw new Error(`Update File patch has multiple move targets: ${action.path}`);
				const moveTo = bodyLine.slice("*** Move to:".length).trim();
				if (!moveTo) throw new Error(`Move target is empty for ${action.path}.`);
				action.moveTo = moveTo;
				index++;
				continue;
			}
			if (bodyLine.startsWith("@@")) {
				if (action.kind === "add") throw new Error(`Add File patches must not use hunk headers; include only '+' lines: ${action.path}`);
				if (bodyLine !== "@@" && !/^@@(?:\s.*)?$/.test(bodyLine)) throw new Error(`Malformed hunk header in ${action.path}.`);
				if (current && (current.lines.length > 0 || (action.kind === "update" && current.section !== undefined))) action.hunks.push(current);
				const sectionText = bodyLine === "@@" ? "" : bodyLine.slice(3);
				current = sectionText.length > 0 ? { lines: [], section: sectionText } : { lines: [] };
				index++;
				continue;
			}
			if (!current) {
				if (action.kind === "add") current = { lines: [] };
				else if (action.kind === "delete" && bodyLine.trim() === "") {
					index++;
					continue;
				} else throw new Error(`Patch lines must follow an '@@' hunk header: ${action.path}`);
			}
			ensurePatchLine(action, bodyLine);
			current.lines.push(bodyLine);
			index++;
		}
		if (current && (current.lines.length > 0 || (action.kind === "update" && current.section !== undefined))) action.hunks.push(current);
		if (action.kind === "delete" && action.hunks.length > 0) throw new Error(`Delete File patches must not include hunks: ${action.path}`);
		if (action.kind !== "delete" && action.hunks.length === 0 && !action.moveTo) throw new Error(`Patch action has no hunks: ${action.path}`);
		actions.push(action);
	}
	if (!sawEnd) throw new Error("Patch must end with '*** End Patch'.");
	if (lines.slice(index).some((line) => line.trim() !== "")) throw new Error("Patch contains content after '*** End Patch'.");
	if (actions.length === 0) throw new Error("Patch contains no file actions.");
	return { actions };
}

export function actionSummary(action: PatchAction): string {
	if (action.kind === "add") return `create ${action.path}`;
	if (action.kind === "delete") return `delete ${action.path}`;
	if (action.moveTo) return `update ${action.path} and move to ${action.moveTo}`;
	return `update ${action.path}`;
}
