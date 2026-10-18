import { generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { actionSummary, parseApplyPatch, type ParsedPatch, type PatchAction, type PatchHunk } from "./apply-patch-parser.ts";
import {
	WORKSPACE_HARD_MAX_BYTES,
	createHostWorkspaceAccess,
	toWorkspaceRelativePath,
	type WorkspaceAccessV2,
	type WorkspaceCreatedParent,
	type WorkspaceRevision,
} from "./workspace-files.ts";

export type ApplyPatchMutation = "create-directory" | "delete" | "write" | "add" | "chmod" | "remove-directory";

export interface ApplyPatchOptions {
	cwd: string;
	allowAbsolutePaths?: boolean;
	signal?: AbortSignal;
	/** Injected workspace operations. Defaults to Host adapter for cwd. */
	workspace?: WorkspaceAccessV2;
	/** Placement for path policy; defaults from workspace.placement or "host". */
	workspacePlacement?: "host" | "sandbox";
	beforeMutation?: (absolutePath: string, operation: ApplyPatchMutation) => void | Promise<void>;
	/** @internal Test-only post-mutation verification seam; not part of the tool-call schema. */
	afterMutation?: (absolutePath: string, operation: ApplyPatchMutation) => void | Promise<void>;
}

export interface AppliedPatchFile {
	kind: PatchAction["kind"];
	path: string;
	absolutePath: string;
	moveTo?: string;
	absoluteMoveTo?: string;
}

export type ApplyPatchNoopReason = "already_satisfied";

export interface ApplyPatchNoop {
	path: string;
	actionIndex: number;
	hunkIndex: number;
	startLine: number;
	endLine: number;
	reason: ApplyPatchNoopReason;
}

export interface ApplyPatchResult {
	files: AppliedPatchFile[];
	changedFiles: string[];
	noops: ApplyPatchNoop[];
	diff: string;
	patch: string;
	firstChangedLine?: number;
	summary: string;
}

export interface ApplyPatchPreview {
	files: string[];
	noops: ApplyPatchNoop[];
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

/** The read-only file state consumed by the pure in-memory plan builder. */
export interface ApplyPatchFileState {
	exists: boolean;
	isFile: boolean;
	content?: string;
	mode?: number;
	lineEnding?: "\r\n" | "\n";
	bom?: boolean;
}

export interface ApplyPatchResolvedAction {
	action: PatchAction;
	actionIndex: number;
	absolutePath: string;
	absoluteMoveTo?: string;
}

export interface ApplyPatchPlan {
	files: AppliedPatchFile[];
	finalStates: ReadonlyMap<string, ApplyPatchFileState>;
	replacementPaths: ReadonlySet<string>;
	noops: ApplyPatchNoop[];
	changedFiles: string[];
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

const NORMALIZED_FILESYSTEM_ERROR = Symbol("apply_patch.normalized_filesystem_error");

type NormalizedFilesystemError = Error & { [NORMALIZED_FILESYSTEM_ERROR]?: true };

function filesystemError(operation: string, pathValue: string, error: unknown): NormalizedFilesystemError {
	if (error instanceof Error && (error as NormalizedFilesystemError)[NORMALIZED_FILESYSTEM_ERROR]) return error as NormalizedFilesystemError;
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	const codeText = typeof code === "string" ? ` (${code})` : "";
	const message = error instanceof Error ? error.message : String(error);
	const result = new Error(`Could not ${operation} ${pathValue}${codeText}: ${message}`) as NormalizedFilesystemError;
	result[NORMALIZED_FILESYSTEM_ERROR] = true;
	return result;
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function workspacePlacementOf(options: ApplyPatchOptions): "host" | "sandbox" {
	return options.workspacePlacement ?? options.workspace?.placement ?? "host";
}

/** Sandbox placement uses lexical resolve only; Host keeps realpath. */
function resolveCwd(optionsOrCwd: ApplyPatchOptions | string, placement?: "host" | "sandbox"): string {
	if (typeof optionsOrCwd === "string") {
		const mode = placement ?? "host";
		if (mode === "sandbox") return resolve(optionsOrCwd);
		try {
			return realpathSync(resolve(optionsOrCwd));
		} catch (error) {
			throw filesystemError("resolve cwd", optionsOrCwd, error);
		}
	}
	const mode = workspacePlacementOf(optionsOrCwd);
	if (mode === "sandbox") return resolve(optionsOrCwd.cwd);
	try {
		return realpathSync(resolve(optionsOrCwd.cwd));
	} catch (error) {
		throw filesystemError("resolve cwd", optionsOrCwd.cwd, error);
	}
}

function workspaceOf(options: ApplyPatchOptions): WorkspaceAccessV2 {
	if (options.workspace) return options.workspace;
	return createHostWorkspaceAccess(resolveCwd(options), { allowAbsolutePaths: options.allowAbsolutePaths });
}

function workspacePathFor(absolutePath: string, options: ApplyPatchOptions): string {
	return toWorkspaceRelativePath(absolutePath, resolveCwd(options), workspacePlacementOf(options), options.allowAbsolutePaths === true);
}

function sanitizeWorkspaceError(error: unknown, options: ApplyPatchOptions): string {
	const message = error instanceof Error ? error.message : String(error);
	if (workspacePlacementOf(options) !== "sandbox") return message;
	const root = resolveCwd(options);
	// Never let a Host cwd or an arbitrary absolute path cross the Sandbox
	// boundary in diagnostics. Known workspace paths become their Guest spelling;
	// any remaining absolute pathname is redacted rather than guessed.
	return message
		.split(root).join("/workspace")
		.replace(/(?:^|\s)(?:\/private|\/Users|\/tmp)\/[^\s;:,)]*/g, (value) => `${value[0] === " " ? " " : ""}<workspace-path>`);
}

function formatWorkspacePath(pathValue: string, options: ApplyPatchOptions): string {
	if (workspacePlacementOf(options) !== "sandbox") return pathValue;
	try {
		return workspacePathFor(pathValue, options);
	} catch {
		// Already relative / display-only path.
		const root = resolveCwd(options);
		const rel = relative(root, pathValue);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
		return pathValue.startsWith("/") ? pathValue.replace(root, "").replace(/^\/+/, "") || "." : pathValue;
	}
}

export function resolvePatchPath(pathValue: string, options: ApplyPatchOptions): string {
	if (!pathValue) throw new Error("Patch path is empty.");
	const cwd = resolveCwd(options);
	const absoluteInput = isAbsolute(pathValue);
	if (absoluteInput && options.allowAbsolutePaths !== true) throw new Error(`Absolute paths are not allowed: ${pathValue}`);
	const absolute = absoluteInput ? resolve(pathValue) : resolve(cwd, pathValue);
	if (!absoluteInput) {
		if (!isInside(cwd, absolute)) throw new Error(`Patch path escapes cwd: ${pathValue}`);
	} else if (workspacePlacementOf(options) === "sandbox" && !isInside(cwd, absolute)) {
		throw new Error(`Patch path escapes cwd: ${pathValue}`);
	}
	return absolute;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

function stripMarker(line: string): string {
	if (line === "\\ No newline at end of file") return "";
	const marker = line[0];
	return marker === "+" || marker === "-" || marker === " " ? line.slice(1) : line;
}

function hunkOldLines(hunk: PatchHunk): string[] {
	return hunk.lines.filter((line) => line.startsWith("-") || line.startsWith(" ")).map(stripMarker);
}

function hunkNewLines(hunk: PatchHunk): string[] {
	return hunk.lines.filter((line) => line.startsWith("+") || line.startsWith(" ")).map(stripMarker);
}

function addText(action: PatchAction): string {
	const lines = action.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map(stripMarker));
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface DecodedUtf8 {
	content: string;
	bom: boolean;
}

function decodeUtf8(data: Buffer, displayPath: string): DecodedUtf8 {
	const bom = data.length >= UTF8_BOM.length && data.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
	try {
		return {
			content: new TextDecoder("utf-8", { fatal: true }).decode(bom ? data.subarray(UTF8_BOM.length) : data),
			bom,
		};
	} catch {
		throw new Error(`Cannot modify ${displayPath}: existing file contains invalid UTF-8.`);
	}
}

function normalizeLf(content: string): string {
	return content.replace(/\r\n/g, "\n");
}

function lineEnding(content: string, displayPath: string): "\r\n" | "\n" {
	let sawLf = false;
	let sawCrlf = false;
	for (let index = 0; index < content.length; index++) {
		if (content[index] === "\r") {
			if (content[index + 1] !== "\n") {
				throw new Error(`Cannot modify ${displayPath}: CR-only line endings are not supported.`);
			}
			sawCrlf = true;
			index++;
		} else if (content[index] === "\n") {
			sawLf = true;
		}
	}
	if (sawLf && sawCrlf) throw new Error(`Cannot modify ${displayPath}: mixed LF and CRLF line endings are not supported.`);
	return sawCrlf ? "\r\n" : "\n";
}

function restoreLineEndings(content: string, ending: "\r\n" | "\n"): string {
	return ending === "\n" ? content : content.replace(/\n/g, ending);
}

function encodeFileContent(content: string, ending: "\r\n" | "\n", bom = false): Buffer {
	const encoded = Buffer.from(restoreLineEndings(content, ending), "utf8");
	return bom ? Buffer.concat([UTF8_BOM, encoded]) : encoded;
}

interface LogicalText {
	lines: string[];
	trailingNewline: boolean;
}

function logicalText(content: string): LogicalText {
	if (content.length === 0) return { lines: [], trailingNewline: false };
	const trailingNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (trailingNewline) lines.pop();
	return { lines, trailingNewline };
}

function serializeLogicalText(text: LogicalText): string {
	if (text.lines.length === 0) return "";
	const content = text.lines.join("\n");
	return text.trailingNewline ? `${content}\n` : content;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

type LineMatchMode = "exact" | "rstrip" | "trim";

interface LineMatches {
	matches: number[];
	mode: LineMatchMode;
}

function matchedLine(left: string, right: string, mode: LineMatchMode): boolean {
	if (mode === "exact") return left === right;
	if (mode === "rstrip") return left.trimEnd() === right.trimEnd();
	return left.trim() === right.trim();
}

function lineSequenceOccurrences(lines: readonly string[], pattern: readonly string[], minimumStart: number, mode: LineMatchMode): number[] {
	if (pattern.length === 0) return [];
	const matches: number[] = [];
	for (let start = Math.max(0, minimumStart); start <= lines.length - pattern.length; start++) {
		if (pattern.every((line, offset) => matchedLine(lines[start + offset]!, line, mode))) matches.push(start);
	}
	return matches;
}

function tieredLineMatches(lines: readonly string[], pattern: readonly string[], minimumStart = 0, mustEndAt?: number): LineMatches {
	for (const mode of ["exact", "rstrip", "trim"] as const) {
		const matches = lineSequenceOccurrences(lines, pattern, minimumStart, mode)
			.filter((start) => mustEndAt === undefined || start + pattern.length === mustEndAt);
		if (matches.length > 0) return { matches, mode };
	}
	return { matches: [], mode: "trim" };
}

function matchModeDescription(mode: LineMatchMode): string {
	if (mode === "rstrip") return " after ignoring trailing whitespace";
	if (mode === "trim") return " after ignoring leading and trailing whitespace";
	return "";
}

function materializeNewLines(hunkLines: readonly string[], matchedOldLines: readonly string[]): string[] {
	const output: string[] = [];
	let oldIndex = 0;
	for (const line of hunkLines) {
		if (line.startsWith(" ")) {
			output.push(matchedOldLines[oldIndex] ?? line.slice(1));
			oldIndex++;
		} else if (line.startsWith("-")) {
			oldIndex++;
		} else if (line.startsWith("+")) {
			output.push(line.slice(1));
		}
	}
	return output;
}

const RETRY_CONTEXT_RADIUS = 2;
const RETRY_CONTEXT_MAX_CANDIDATES = 3;
const RETRY_CONTEXT_MAX_LINES = 40;
const RETRY_CONTEXT_MAX_CHARS = 8_000;
const RETRY_CONTEXT_MAX_LINE_CHARS = 240;

function escapeDiagnosticControls(line: string): string {
	let escaped = "";
	for (const character of line) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			escaped += code === 0x09 ? "\\t" : `\\x${code.toString(16).padStart(2, "0").toUpperCase()}`;
		} else {
			escaped += character;
		}
	}
	return escaped;
}

function boundedSourceLine(line: string): string {
	const safeLine = escapeDiagnosticControls(line);
	return safeLine.length <= RETRY_CONTEXT_MAX_LINE_CHARS ? safeLine : `${safeLine.slice(0, RETRY_CONTEXT_MAX_LINE_CHARS - 1)}…`;
}

function retryContext(content: string, oldLines: readonly string[], matches: readonly number[]): string {
	if (matches.length === 0) return "";
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const shownMatches = matches.slice(0, RETRY_CONTEXT_MAX_CANDIDATES);
	const sections: string[] = [];
	let renderedLines = 0;

	for (let candidateIndex = 0; candidateIndex < shownMatches.length; candidateIndex++) {
		const matchStart = shownMatches[candidateIndex]!;
		const startLine = matchStart;
		const endLine = Math.min(lines.length - 1, matchStart + oldLines.length - 1);
		const contextStart = Math.max(0, startLine - RETRY_CONTEXT_RADIUS);
		const contextEnd = Math.min(lines.length - 1, endLine + RETRY_CONTEXT_RADIUS);
		const sectionLines = [`Candidate ${candidateIndex + 1}: matched lines ${startLine + 1}-${endLine + 1}`];

		for (let lineIndex = contextStart; lineIndex <= contextEnd; lineIndex++) {
			if (renderedLines >= RETRY_CONTEXT_MAX_LINES) break;
			const marker = lineIndex >= startLine && lineIndex <= endLine ? ">" : " ";
			sectionLines.push(`${marker} ${String(lineIndex + 1).padStart(4)} | ${boundedSourceLine(lines[lineIndex] ?? "")}`);
			renderedLines++;
		}
		sections.push(sectionLines.join("\n"));
		if (renderedLines >= RETRY_CONTEXT_MAX_LINES) break;
	}

	const omittedCandidates = matches.length - sections.length;
	const notices: string[] = [];
	if (omittedCandidates > 0) notices.push(`… ${omittedCandidates} more candidate${omittedCandidates === 1 ? "" : "s"} omitted; use read if the shown windows are insufficient.`);
	if (renderedLines >= RETRY_CONTEXT_MAX_LINES) notices.push(`… source context truncated after ${RETRY_CONTEXT_MAX_LINES} lines.`);
	const suffix = notices.length > 0 ? `\n\n${notices.join("\n")}` : "";
	const body = sections.join("\n\n");
	if (body.length + suffix.length <= RETRY_CONTEXT_MAX_CHARS) return `${body}${suffix}`;
	const truncationNotice = "\n… source context truncated by character limit.";
	const bodyLimit = Math.max(0, RETRY_CONTEXT_MAX_CHARS - suffix.length - truncationNotice.length);
	return `${body.slice(0, bodyLimit)}${truncationNotice}${suffix}`;
}

interface ReplacedHunk {
	content: string;
	cursor: number;
	navigation?: boolean;
	noop?: Pick<ApplyPatchNoop, "startLine" | "endLine">;
}

const AMBIGUOUS_CONTEXT_GUIDANCE = "By default, include 3 complete lines immediately above and 3 complete lines immediately below the change. If that is still not unique, use @@ followed by the enclosing class, function, method, test, or other unique section. Multiple @@ section headers may be used for nested context.";

function repeatedClosingInsertion(oldLines: readonly string[], newLines: readonly string[]): string | undefined {
	if (oldLines.length !== 1 || newLines.length <= oldLines.length || newLines[0] !== oldLines[0]) return undefined;
	const line = oldLines[0]!.trim();
	return ["}", "});", "};", "]", "];", "],", ")", ");"].includes(line) || /^<\/[^>]+>$/.test(line) ? line : undefined;
}

function replaceHunk(
	content: string,
	oldLines: readonly string[],
	newLines: readonly string[],
	hunkLines: readonly string[],
	path: string,
	actionIndex: number,
	hunkIndex: number,
	cursor: number,
	section?: string,
	endOfFile = false,
): ReplacedHunk {
	const location = `actions[${actionIndex}].hunks[${hunkIndex}]`;
	const current = logicalText(content);
	let searchStart = cursor;
	let sectionAnchor: number | undefined;
	if (section !== undefined) {
		const sectionResult = tieredLineMatches(current.lines, [section], cursor);
		const sectionMatches = sectionResult.matches;
		if (sectionMatches.length === 0) {
			throw new Error(`Section not found: ${JSON.stringify(boundedSourceLine(section))} for ${location} in ${path} at or after logical line ${cursor + 1}; section lines were not found after exact and whitespace-tolerant matching.`);
		}
		if (sectionMatches.length > 1) {
			const shownLines = sectionMatches.slice(0, RETRY_CONTEXT_MAX_CANDIDATES).map((index) => index + 1).join(", ");
			const omitted = sectionMatches.length - RETRY_CONTEXT_MAX_CANDIDATES;
			const omittedText = omitted > 0 ? `; ${omitted} more omitted` : "";
			throw new Error(`Found ${sectionMatches.length} occurrences of section ${JSON.stringify(boundedSourceLine(section))}${matchModeDescription(sectionResult.mode)} for ${location} in ${path} at logical lines ${shownLines}${omittedText}; section lines must be unique at or after the current cursor.`);
		}
		sectionAnchor = sectionMatches[0]!;
		searchStart = sectionAnchor + 1;
	}
	if (oldLines.length === 0) {
		if (newLines.length === 0 && sectionAnchor !== undefined) return { content, cursor: sectionAnchor + 1, navigation: true };
		if (newLines.length === 0) throw new Error(`No changes made by ${location} in ${path}: old and new text are identical and empty.`);
		const insertStart = endOfFile ? current.lines.length : sectionAnchor === undefined ? current.lines.length : sectionAnchor + 1;
		const lines = [...current.lines.slice(0, insertStart), ...newLines, ...current.lines.slice(insertStart)];
		return {
			content: serializeLogicalText({ lines, trailingNewline: current.trailingNewline }),
			cursor: insertStart + newLines.length,
		};
	}
	const matchResult = tieredLineMatches(current.lines, oldLines, searchStart, endOfFile ? current.lines.length : undefined);
	const matches = matchResult.matches;
	if (matches.length === 0) {
		if (endOfFile) {
			throw new Error(`Could not find EOF hunk ${location} in ${path}; the old text was not found after exact and whitespace-tolerant matching at the logical end of file.`);
		}
		throw new Error(`Could not find ${location} in ${path}; hunk not found after exact and whitespace-tolerant matching of complete lines.`);
	}
	if (matches.length > 1) {
		const closingLine = repeatedClosingInsertion(oldLines, newLines);
		const closingGuidance = closingLine ? `\n\nThis hunk inserts after the repeated closing line ${JSON.stringify(closingLine)}; do not retry with that line alone.` : "";
		throw new Error(`Found ${matches.length} occurrences of ${location} in ${path}${matchModeDescription(matchResult.mode)}. The old text must be unique and cover complete lines.\n\n${AMBIGUOUS_CONTEXT_GUIDANCE}${closingGuidance}\n\nCurrent source candidates:\n${retryContext(content, oldLines, matches)}`);
	}
	const start = matches[0]!;
	const matchedOldLines = current.lines.slice(start, start + oldLines.length);
	const effectiveNewLines = materializeNewLines(hunkLines, matchedOldLines);
	if (sameLines(matchedOldLines, effectiveNewLines)) {
		return {
			content,
			cursor: start + oldLines.length,
			noop: { startLine: start + 1, endLine: start + oldLines.length },
		};
	}
	const lines = [...current.lines.slice(0, start), ...effectiveNewLines, ...current.lines.slice(start + oldLines.length)];
	return {
		content: serializeLogicalText({ lines, trailingNewline: current.trailingNewline && lines.length > 0 }),
		cursor: start + effectiveNewLines.length,
	};
}

interface FileSnapshot extends ApplyPatchFileState {
	absolutePath: string;
	workspacePath: string;
	data?: Buffer;
	revision?: WorkspaceRevision;
}

async function snapshotPath(absolutePath: string, options: ApplyPatchOptions, readContent = true): Promise<FileSnapshot> {
	const workspace = workspaceOf(options);
	const workspacePath = workspacePathFor(absolutePath, options);
	const entry = await workspace.inspect(workspacePath, {
		read: readContent,
		maxBytes: readContent ? WORKSPACE_HARD_MAX_BYTES : undefined,
		symlinks: "reject",
		requireSingleLink: true,
		signal: options.signal,
	});
	if (entry.kind === "missing") return { absolutePath, workspacePath, exists: false, isFile: false, bom: false };
	if (entry.kind === "directory") {
		return { absolutePath, workspacePath, exists: true, isFile: false, mode: entry.mode, revision: entry.revision };
	}
	const data = entry.bytes ? Buffer.from(entry.bytes) : undefined;
	if (readContent && !data) throw new Error(`Could not read file ${formatWorkspacePath(absolutePath, options)}`);
	if (!data) {
		return { absolutePath, workspacePath, exists: true, isFile: true, mode: entry.mode, revision: entry.revision };
	}
	const display = formatWorkspacePath(absolutePath, options);
	const decoded = decodeUtf8(data, display);
	return {
		absolutePath,
		workspacePath,
		exists: true,
		isFile: true,
		data,
		content: normalizeLf(decoded.content),
		mode: entry.mode,
		lineEnding: lineEnding(decoded.content, display),
		bom: decoded.bom,
		revision: entry.revision,
	};
}

async function readSnapshots(paths: readonly string[], options: ApplyPatchOptions): Promise<Map<string, FileSnapshot>> {
	const snapshots = new Map<string, FileSnapshot>();
	for (const pathValue of paths) snapshots.set(pathValue, await snapshotPath(pathValue, options, true));
	return snapshots;
}

function missingSnapshot(absolutePath: string, options: ApplyPatchOptions): FileSnapshot {
	return { absolutePath, workspacePath: workspacePathFor(absolutePath, options), exists: false, isFile: false, bom: false };
}

function rememberWrittenState(pathValue: string, snapshot: FileSnapshot, writtenStates: Map<string, FileSnapshot>, writtenOrder: string[]): void {
	if (!writtenStates.has(pathValue)) writtenOrder.push(pathValue);
	writtenStates.set(pathValue, snapshot);
}

function sameExpectedSnapshot(actual: FileSnapshot | undefined, expected: FileSnapshot): boolean {
	if (!actual || actual.exists !== expected.exists || actual.isFile !== expected.isFile) return false;
	if (expected.content !== undefined && actual.content !== expected.content) return false;
	if (expected.mode !== undefined && actual.mode !== expected.mode) return false;
	if (expected.lineEnding !== undefined && actual.lineEnding !== expected.lineEnding) return false;
	if (expected.bom !== undefined && Boolean(actual.bom) !== Boolean(expected.bom)) return false;
	if (expected.data !== undefined && (!actual.data || !actual.data.equals(expected.data))) return false;
	if (expected.revision !== undefined && actual.revision !== expected.revision) return false;
	return true;
}

interface MutationJournal {
	writtenStates: Map<string, FileSnapshot>;
	writtenOrder: string[];
	indeterminatePaths: Set<string>;
}

function markIndeterminate(journal: MutationJournal | undefined, absolutePath: string): void {
	journal?.indeterminatePaths.add(absolutePath);
}

function absoluteFromWorkspacePath(workspacePath: string, options: ApplyPatchOptions): string {
	if (isAbsolute(workspacePath)) return resolve(workspacePath);
	return resolve(resolveCwd(options), ...workspacePath.split("/").filter((part) => part && part !== "."));
}

function recordCreatedParents(
	journal: MutationJournal | undefined,
	parents: readonly WorkspaceCreatedParent[],
	options: ApplyPatchOptions,
): void {
	if (!journal) return;
	for (const parent of parents) {
		const absolutePath = absoluteFromWorkspacePath(parent.path, options);
		rememberWrittenState(absolutePath, {
			absolutePath,
			workspacePath: parent.path,
			exists: true,
			isFile: false,
			// Public parent results intentionally omit mode; its opaque revision already
			// binds the directory identity and permission bits.
			mode: undefined,
			revision: parent.revision,
		}, journal.writtenStates, journal.writtenOrder);
	}
}

async function journalMutation(
	journal: MutationJournal | undefined,
	absolutePath: string,
	operation: ApplyPatchMutation,
	before: FileSnapshot,
	expectedAfter: FileSnapshot,
	mutate: () => Promise<FileSnapshot | void>,
	options: ApplyPatchOptions,
): Promise<FileSnapshot> {
	try {
		const maybe = await mutate();
		await options.afterMutation?.(absolutePath, operation);
		if (maybe) {
			if (!sameExpectedSnapshot(maybe, { ...expectedAfter, revision: expectedAfter.revision ?? maybe.revision, mode: expectedAfter.mode ?? maybe.mode })) {
				// Allow expectedAfter to omit revision/mode when caller cannot know them yet; re-read below.
			}
		}
	} catch (error) {
		try {
			const current = await snapshotPath(absolutePath, options, before.isFile || expectedAfter.isFile);
			if (!sameSnapshot(current, before)) markIndeterminate(journal, absolutePath);
		} catch {
			markIndeterminate(journal, absolutePath);
		}
		throw error;
	}

	let actualAfter: FileSnapshot;
	try {
		actualAfter = await snapshotPath(absolutePath, options, expectedAfter.isFile || expectedAfter.content !== undefined || expectedAfter.data !== undefined);
	} catch (error) {
		markIndeterminate(journal, absolutePath);
		throw error;
	}
	const expectedForCompare: FileSnapshot = {
		...expectedAfter,
		revision: expectedAfter.revision ?? actualAfter.revision,
		mode: expectedAfter.mode ?? actualAfter.mode,
	};
	if (!sameExpectedSnapshot(actualAfter, expectedForCompare)) {
		markIndeterminate(journal, absolutePath);
		throw new Error(`Post-mutation verification failed for ${operation} ${formatWorkspacePath(absolutePath, options)}.`);
	}
	if (journal) rememberWrittenState(absolutePath, actualAfter, journal.writtenStates, journal.writtenOrder);
	return actualAfter;
}

async function assertStableBeforeMutation(
	absolutePath: string,
	expected: FileSnapshot,
	operation: ApplyPatchMutation,
	options: ApplyPatchOptions,
): Promise<void> {
	await options.beforeMutation?.(absolutePath, operation);
	const current = await snapshotPath(absolutePath, options, expected.isFile);
	if (!sameSnapshot(current, expected)) {
		throw new Error(`Concurrent change detected before ${operation} ${formatWorkspacePath(absolutePath, options)}.`);
	}
}

async function rollbackWrittenStates(
	initialSnapshots: ReadonlyMap<string, FileSnapshot>,
	writtenStates: ReadonlyMap<string, FileSnapshot>,
	writtenOrder: readonly string[],
	indeterminatePaths: ReadonlySet<string>,
	options: ApplyPatchOptions,
): Promise<void> {
	const workspace = workspaceOf(options);
	const conflicts: string[] = [...indeterminatePaths].sort().map((absolutePath) => `${formatWorkspacePath(absolutePath, options)} has an indeterminate post-mutation state`);
	for (const absolutePath of [...writtenOrder].reverse()) {
		if (indeterminatePaths.has(absolutePath)) continue;
		const written = writtenStates.get(absolutePath)!;
		try {
			const current = await snapshotPath(absolutePath, options, written.isFile);
			const matchesWritten = !written.isFile
				? sameExpectedSnapshot(current, written)
				: sameSnapshot(current, written);
			if (!matchesWritten) {
				conflicts.push(`${formatWorkspacePath(absolutePath, options)} no longer matches the state written by this operation`);
				continue;
			}
			const original = initialSnapshots.get(absolutePath) ?? missingSnapshot(absolutePath, options);
			if (!original.exists) {
				if (!written.exists) continue;
				if (!written.revision) {
					conflicts.push(`${formatWorkspacePath(absolutePath, options)} cannot be removed because its written revision is unknown`);
					continue;
				}
				const operation = written.isFile ? "delete" : "remove-directory";
				const expected = missingSnapshot(absolutePath, options);
				await journalMutation(
					undefined,
					absolutePath,
					operation,
					written,
					expected,
					async () => {
						await workspace.remove(written.workspacePath, {
							expected: written.revision!,
							kind: written.isFile ? "file" : "empty-directory",
							signal: options.signal,
						});
					},
					options,
				);
				continue;
			}
			if (!original.isFile || !original.data) {
				conflicts.push(`${formatWorkspacePath(absolutePath, options)} cannot be restored because its original state was not a regular file`);
				continue;
			}
			const restoreExpected = written.exists ? written.revision : "missing";
			if (written.exists && !written.revision) {
				conflicts.push(`${formatWorkspacePath(absolutePath, options)} cannot be restored because its written revision is unknown`);
				continue;
			}
			const expectedAfterWrite: FileSnapshot = { ...original, mode: undefined, revision: undefined };
			const afterWrite = await journalMutation(
				undefined,
				absolutePath,
				"write",
				written,
				expectedAfterWrite,
				async () => {
					const result = await workspace.writeFile(written.workspacePath, original.data!, {
						expected: restoreExpected!,
						publication: "in-place",
						creation: "workspace-default",
						finalMode: original.mode,
						signal: options.signal,
					});
					return {
						...expectedAfterWrite,
						mode: original.mode,
						revision: result.revision,
						data: original.data,
					};
				},
				options,
			);
			void afterWrite;
		} catch (error) {
			conflicts.push(`${formatWorkspacePath(absolutePath, options)}: ${sanitizeWorkspaceError(error, options)}`);
		}
	}
	if (conflicts.length > 0) throw new Error(`Rollback conflict: ${conflicts.join("; ")}`);
}

function resolveActionPaths(parsed: ParsedPatch, options: ApplyPatchOptions): ApplyPatchResolvedAction[] {
	return parsed.actions.map((action, actionIndex) => {
		let absolutePath: string;
		let absoluteMoveTo: string | undefined;
		try {
			absolutePath = resolvePatchPath(action.path, options);
		} catch (error) {
			throw new Error(`Rejected actions[${actionIndex}] path (${action.path}): ${error instanceof Error ? error.message : String(error)}`);
		}
		if (action.moveTo) {
			try {
				absoluteMoveTo = resolvePatchPath(action.moveTo, options);
			} catch (error) {
				throw new Error(`Rejected actions[${actionIndex}].moveTo (${action.moveTo}): ${error instanceof Error ? error.message : String(error)}`);
			}
			if (absoluteMoveTo.startsWith(`${absolutePath}${sep}`)) {
				throw new Error(`Rejected actions[${actionIndex}].moveTo (${action.moveTo}): destination cannot be inside the source path (${action.path}).`);
			}
		}
		return { action, actionIndex, absolutePath, absoluteMoveTo };
	});
}

function touchedPaths(resolved: readonly ApplyPatchResolvedAction[]): string[] {
	return [...new Set(resolved.flatMap((item) => [item.absolutePath, item.absoluteMoveTo].filter((value): value is string => Boolean(value))))].sort();
}

function stateCopy(state: ApplyPatchFileState): ApplyPatchFileState {
	return { exists: state.exists, isFile: state.isFile, content: state.content, mode: state.mode, lineEnding: state.lineEnding, bom: state.bom };
}

function initialState(initialFiles: ReadonlyMap<string, ApplyPatchFileState>, absolutePath: string): ApplyPatchFileState {
	return stateCopy(initialFiles.get(absolutePath) ?? { exists: false, isFile: false });
}

function actionPathError(action: PatchAction, actionIndex: number, operation: "add" | "update" | "delete"): Error {
	const target = `actions[${actionIndex}] (${action.path})`;
	if (operation === "add") return new Error(`Cannot add ${target}: path already exists.`);
	if (operation === "delete") return new Error(`Cannot delete ${target}: path does not exist.`);
	return new Error(`Cannot update ${target}: path does not exist.`);
}

function assertActionFile(state: ApplyPatchFileState, action: PatchAction, actionIndex: number, operation: "update" | "delete"): void {
	if (!state.exists) throw actionPathError(action, actionIndex, operation);
	if (!state.isFile) throw new Error(`Cannot ${operation} actions[${actionIndex}] (${action.path}): path is not a regular file.`);
}

function sameState(left: ApplyPatchFileState | undefined, right: ApplyPatchFileState | undefined): boolean {
	const a = left ?? { exists: false, isFile: false };
	const b = right ?? { exists: false, isFile: false };
	return a.exists === b.exists && a.isFile === b.isFile && a.content === b.content && a.mode === b.mode && a.lineEnding === b.lineEnding && Boolean(a.bom) === Boolean(b.bom);
}

function sameSnapshot(left: FileSnapshot | undefined, right: FileSnapshot | undefined): boolean {
	const a = left ?? { exists: false as const, isFile: false as const, bom: false as const };
	const b = right ?? { exists: false as const, isFile: false as const, bom: false as const };
	if (a.exists !== b.exists || a.isFile !== b.isFile) return false;
	// Directories only compare identity fields: content/lineEnding/bom are file-only.
	// Mode is compared only when both sides provide it (createdParents always should).
	if (!a.isFile && !b.isFile) {
		if (a.exists && b.exists) {
			const leftRevision = left?.revision;
			const rightRevision = right?.revision;
			if (leftRevision !== rightRevision) return false;
			const leftMode = left?.mode;
			const rightMode = right?.mode;
			if (leftMode !== undefined && rightMode !== undefined && leftMode !== rightMode) return false;
		}
		return true;
	}
	if (!sameState(left, right)) return false;
	if (left?.revision !== right?.revision) return false;
	if (left?.isFile || right?.isFile) {
		if (left?.data && right?.data) return left.data.equals(right.data);
		if (left?.data || right?.data) return false;
	}
	return true;
}

function displayPath(cwd: string, absolutePath: string, placement: "host" | "sandbox" = "host"): string {
	const root = resolveCwd(cwd, placement);
	const rel = relative(root, absolutePath);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
	if (placement === "sandbox") {
		// Never leak Host absolute cwd paths into sandbox diagnostics/results.
		return absolutePath.startsWith(root + sep) || absolutePath === root
			? (relative(root, absolutePath).split(sep).join("/") || ".")
			: absolutePath.replace(/\\/g, "/").replace(/^.*\//, "") || ".";
	}
	return absolutePath;
}

function buildPlanDetails(
	cwd: string,
	touched: readonly string[],
	initialFiles: ReadonlyMap<string, ApplyPatchFileState>,
	finalStates: ReadonlyMap<string, ApplyPatchFileState>,
	placement: "host" | "sandbox" = "host",
): Pick<ApplyPatchPlan, "changedFiles" | "diff" | "patch" | "firstChangedLine"> {
	const changes: Array<{ path: string; diff: string }> = [];
	const patches: string[] = [];
	const changedFiles: string[] = [];
	let firstChangedLine: number | undefined;
	for (const absolutePath of touched) {
		const before = initialState(initialFiles, absolutePath);
		const after = finalStates.get(absolutePath) ?? { exists: false, isFile: false };
		if (sameState(before, after)) continue;
		const path = displayPath(cwd, absolutePath, placement);
		changedFiles.push(path);
		const oldText = before.exists && before.isFile ? before.content ?? "" : "";
		const newText = after.exists && after.isFile ? after.content ?? "" : "";
		const result = generateDiffString(normalizeLf(oldText), normalizeLf(newText));
		if (result.diff) changes.push({ path, diff: result.diff });
		if (result.diff && result.firstChangedLine !== undefined) {
			firstChangedLine = Math.min(firstChangedLine ?? result.firstChangedLine, result.firstChangedLine);
		}
		const patch = generateUnifiedPatch(path, normalizeLf(oldText), normalizeLf(newText));
		if (patch) patches.push(patch);
	}
	return {
		changedFiles,
		diff: changes.length === 1 ? changes[0]!.diff : changes.map((change) => `File: ${change.path}\n${change.diff}`).join("\n\n"),
		patch: patches.join("\n"),
		...(firstChangedLine === undefined ? {} : { firstChangedLine }),
	};
}

/**
 * Build the final virtual filesystem state without writing anything.
 * Matching and action sequencing are shared by preview and execution.
 */
export function buildApplyPatchPlan(
	parsed: ParsedPatch,
	resolved: readonly ApplyPatchResolvedAction[],
	initialFiles: ReadonlyMap<string, ApplyPatchFileState>,
	cwd: string,
	placement: "host" | "sandbox" = "host",
): ApplyPatchPlan {
	const finalStates = new Map<string, ApplyPatchFileState>();
	for (const absolutePath of touchedPaths(resolved)) finalStates.set(absolutePath, initialState(initialFiles, absolutePath));
	const replacementPaths = new Set<string>();
	const files: AppliedPatchFile[] = [];
	const noops: ApplyPatchNoop[] = [];
	let hasEffectiveMutation = false;

	for (const item of resolved) {
		const { action, actionIndex, absolutePath, absoluteMoveTo } = item;
		let current = stateCopy(finalStates.get(absolutePath) ?? { exists: false, isFile: false });
		if (action.kind === "add") {
			if (current.exists) throw actionPathError(action, actionIndex, "add");
			if (initialFiles.get(absolutePath)?.exists) replacementPaths.add(absolutePath);
			hasEffectiveMutation = true;
			finalStates.set(absolutePath, { exists: true, isFile: true, content: addText(action), lineEnding: "\n" });
			files.push({ absolutePath, kind: action.kind, path: action.path });
			continue;
		}

		assertActionFile(current, action, actionIndex, action.kind);
		if (action.kind === "update") {
			let content = normalizeLf(current.content ?? "");
			let cursor = 0;
			for (let hunkIndex = 0; hunkIndex < action.hunks.length; hunkIndex++) {
				const hunk = action.hunks[hunkIndex]!;
				const oldLines = hunkOldLines(hunk);
				const newLines = hunkNewLines(hunk);
				const replacement = replaceHunk(content, oldLines, newLines, hunk.lines, action.path, actionIndex, hunkIndex, cursor, hunk.section, hunk.endOfFile);
				content = replacement.content;
				cursor = replacement.cursor;
				if (replacement.navigation) continue;
				if (replacement.noop) {
					noops.push({
						path: action.path,
						actionIndex,
						hunkIndex,
						...replacement.noop,
						reason: "already_satisfied",
					});
				} else {
					hasEffectiveMutation = true;
				}
			}
			current = { ...current, content };
			finalStates.set(absolutePath, current);
			if (absoluteMoveTo) {
				const destination = finalStates.get(absoluteMoveTo) ?? { exists: false, isFile: false };
				if (destination.exists) throw new Error(`Cannot move actions[${actionIndex}] (${action.path}): destination already exists (${action.moveTo}).`);
				hasEffectiveMutation = true;
				finalStates.set(absolutePath, { exists: false, isFile: false });
				finalStates.set(absoluteMoveTo, { ...current });
			}
			files.push({ absoluteMoveTo, absolutePath, kind: action.kind, moveTo: action.moveTo, path: action.path });
			continue;
		}

		finalStates.set(absolutePath, { exists: false, isFile: false });
		hasEffectiveMutation = true;
		files.push({ absolutePath, kind: action.kind, path: action.path });
	}

	const details = buildPlanDetails(cwd, touchedPaths(resolved), initialFiles, finalStates, placement);
	const effectiveReplacementPaths = new Set([...replacementPaths].filter((absolutePath) => finalStates.get(absolutePath)?.exists));
	const changedFiles = [...new Set([
		...details.changedFiles,
		...[...effectiveReplacementPaths].map((absolutePath) => displayPath(cwd, absolutePath, placement)),
	])].sort();
	if (changedFiles.length === 0 && (hasEffectiveMutation || noops.length === 0)) throw new Error("Patch made no filesystem changes.");
	return { files, finalStates, replacementPaths: effectiveReplacementPaths, noops, ...details, changedFiles };
}

function assertResolvedPathsStable(before: readonly ApplyPatchResolvedAction[], after: readonly ApplyPatchResolvedAction[]): void {
	if (before.length !== after.length) throw new Error("Patch actions changed during apply.");
	for (let index = 0; index < before.length; index++) {
		if (before[index]!.absolutePath !== after[index]!.absolutePath || before[index]!.absoluteMoveTo !== after[index]!.absoluteMoveTo) {
			throw new Error(`Patch path changed during apply: ${before[index]!.action.path}`);
		}
	}
}

async function commitPlan(
	plan: ApplyPatchPlan,
	initialSnapshots: ReadonlyMap<string, FileSnapshot>,
	options: ApplyPatchOptions,
	journal: MutationJournal,
): Promise<void> {
	const workspace = workspaceOf(options);
	for (const absolutePath of [...plan.finalStates.keys()].sort()) {
		throwIfAborted(options.signal);
		const beforeSnapshot = initialSnapshots.get(absolutePath) ?? missingSnapshot(absolutePath, options);
		const before = stateCopy(beforeSnapshot);
		const after = plan.finalStates.get(absolutePath) ?? { exists: false, isFile: false };
		if (sameState(before, after)) continue;
		const workspacePath = beforeSnapshot.workspacePath || workspacePathFor(absolutePath, options);
		if (!after.exists) {
			await assertStableBeforeMutation(absolutePath, beforeSnapshot, "delete", options);
			if (!beforeSnapshot.revision) throw new Error(`Cannot delete ${formatWorkspacePath(absolutePath, options)}: missing revision`);
			await journalMutation(
				journal,
				absolutePath,
				"delete",
				beforeSnapshot,
				missingSnapshot(absolutePath, options),
				async () => {
					await workspace.remove(workspacePath, {
						expected: beforeSnapshot.revision!,
						kind: "file",
						signal: options.signal,
					});
				},
				options,
			);
			continue;
		}
		let writeBefore = beforeSnapshot;
		let operation: ApplyPatchMutation = before.exists ? "write" : "add";
		if (before.exists && plan.replacementPaths.has(absolutePath)) {
			await assertStableBeforeMutation(absolutePath, beforeSnapshot, "delete", options);
			if (!beforeSnapshot.revision) throw new Error(`Cannot replace ${formatWorkspacePath(absolutePath, options)}: missing revision`);
			writeBefore = await journalMutation(
				journal,
				absolutePath,
				"delete",
				beforeSnapshot,
				missingSnapshot(absolutePath, options),
				async () => {
					await workspace.remove(workspacePath, {
						expected: beforeSnapshot.revision!,
						kind: "file",
						signal: options.signal,
					});
				},
				options,
			);
			operation = "add";
		}
		await assertStableBeforeMutation(absolutePath, writeBefore, operation, options);
		const data = encodeFileContent(after.content ?? "", after.lineEnding ?? "\n", Boolean(after.bom));
		const expectedAfterWrite: FileSnapshot = {
			absolutePath,
			workspacePath,
			exists: true,
			isFile: true,
			content: after.content ?? "",
			lineEnding: after.lineEnding ?? "\n",
			bom: Boolean(after.bom),
			data,
		};
		await journalMutation(
			journal,
			absolutePath,
			operation,
			writeBefore,
			expectedAfterWrite,
			async () => {
				const result = await workspace.writeFile(workspacePath, data, {
					expected: operation === "add" || writeBefore.exists === false ? "missing" : writeBefore.revision!,
					publication: "in-place",
					creation: "workspace-default",
					finalMode: after.mode,
					signal: options.signal,
				});
				recordCreatedParents(journal, result.createdParents, options);
				return {
					...expectedAfterWrite,
					revision: result.revision,
					mode: after.mode,
				};
			},
			options,
		);
	}
}

async function withTouchedMutationQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const sorted = [...new Set(paths)].sort();
	const run = async (index: number): Promise<T> => {
		if (index >= sorted.length) return fn();
		return withFileMutationQueue(sorted[index]!, () => run(index + 1));
	};
	return run(0);
}

/**
 * Read files and return a preview; this function never writes to the filesystem.
 * Callers that must avoid Host filesystem I/O (Sandbox-enabled TUI renderCall)
 * should either inject a non-Host workspace adapter or use lexical path-list
 * presentation instead of this function.
 */
export async function computeApplyPatchPreview(input: string, options: ApplyPatchOptions): Promise<ApplyPatchPreview | { error: string }> {
	try {
		throwIfAborted(options.signal);
		const parsed = parseApplyPatch(input);
		const resolved = resolveActionPaths(parsed, options);
		const snapshots = await readSnapshots(touchedPaths(resolved), options);
		const plan = buildApplyPatchPlan(
			parsed,
			resolved,
			snapshots,
			resolveCwd(options),
			workspacePlacementOf(options),
		);
		return {
			files: plan.changedFiles,
			noops: plan.noops,
			diff: plan.diff,
			patch: plan.patch,
			...(plan.firstChangedLine === undefined ? {} : { firstChangedLine: plan.firstChangedLine }),
		};
	} catch (error) {
		return { error: sanitizeWorkspaceError(error, options) };
	}
}

export function applyPatchTargetPaths(input: string, cwd: string, allowAbsolutePaths = false): string[] {
	const parsed = parseApplyPatch(input);
	return touchedPaths(resolveActionPaths(parsed, { allowAbsolutePaths, cwd }));
}

export async function applyParsedPatch(parsed: ParsedPatch, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	throwIfAborted(options.signal);
	// Ensure a stable workspace for this apply (default Host adapter when none injected).
	const workspace = workspaceOf(options);
	const applyOptions: ApplyPatchOptions = {
		...options,
		workspace,
		workspacePlacement: options.workspacePlacement ?? workspace.placement,
	};
	let resolvedBeforeQueue: ApplyPatchResolvedAction[];
	try {
		resolvedBeforeQueue = resolveActionPaths(parsed, applyOptions);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nNo files were changed.`);
	}
	const pathsBeforeQueue = touchedPaths(resolvedBeforeQueue);
	return withTouchedMutationQueues(pathsBeforeQueue, async () => {
		let snapshots = new Map<string, FileSnapshot>();
		let mutationStarted = false;
		const journal: MutationJournal = {
			writtenStates: new Map<string, FileSnapshot>(),
			writtenOrder: [],
			indeterminatePaths: new Set<string>(),
		};
		try {
			throwIfAborted(applyOptions.signal);
			const resolved = resolveActionPaths(parsed, applyOptions);
			assertResolvedPathsStable(resolvedBeforeQueue, resolved);
			const paths = touchedPaths(resolved);
			snapshots = await readSnapshots(paths, applyOptions);
			// Build from live snapshots inside the queues. A preview is advisory; this is the authoritative revalidation.
			const plan = buildApplyPatchPlan(
				parsed,
				resolved,
				snapshots,
				resolveCwd(applyOptions),
				workspacePlacementOf(applyOptions),
			);
			throwIfAborted(applyOptions.signal);
			if (plan.changedFiles.length > 0) {
				mutationStarted = true;
				await commitPlan(plan, snapshots, applyOptions, journal);
			}
			throwIfAborted(applyOptions.signal);
			const noopHunks = `${plan.noops.length} hunk${plan.noops.length === 1 ? "" : "s"}`;
			const summary = plan.changedFiles.length === 0
				? `Patch already satisfied: ${noopHunks} required no change.`
				: `Applied patch: ${parsed.actions.map(actionSummary).join(", ")}${plan.noops.length > 0 ? `. ${noopHunks} already satisfied.` : ""}`;
			const files = workspacePlacementOf(applyOptions) === "sandbox"
				? plan.files.map((file) => ({
					...file,
					absolutePath: `/workspace/${workspacePathFor(file.absolutePath, applyOptions)}`,
					...(file.absoluteMoveTo === undefined
						? {}
						: { absoluteMoveTo: `/workspace/${workspacePathFor(file.absoluteMoveTo, applyOptions)}` }),
				}))
				: plan.files;
			return {
				files,
				changedFiles: plan.changedFiles,
				noops: plan.noops,
				diff: plan.diff,
				patch: plan.patch,
				...(plan.firstChangedLine === undefined ? {} : { firstChangedLine: plan.firstChangedLine }),
				summary,
			};
		} catch (error) {
			if (!mutationStarted) {
				const message = sanitizeWorkspaceError(error, applyOptions);
				if (message === "Operation aborted." || /aborted/i.test(message)) throw new Error(message);
				throw new Error(`${message}\nNo files were changed.`);
			}
			try {
				// Fresh same-VM rollback: do not inherit the caller's aborted signal, so
				// ordinary Abort still restores the workspace through the same adapter.
				// Bound the cleanup so a stuck Guest cannot hang the tool forever.
				const cleanupSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
					? AbortSignal.timeout(30_000)
					: undefined;
				await rollbackWrittenStates(
					snapshots,
					journal.writtenStates,
					journal.writtenOrder,
					journal.indeterminatePaths,
					{ ...applyOptions, signal: cleanupSignal },
				);
			} catch (rollbackError) {
				const original = sanitizeWorkspaceError(error, applyOptions);
				throw new Error(`${original}; workspace mutation state uncertain: ${sanitizeWorkspaceError(rollbackError, applyOptions)}`);
			}
			const message = sanitizeWorkspaceError(error, applyOptions);
			throw new Error(`${message}\nRolled back all touched files.`);
		}
	});
}

export async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	return applyParsedPatch(parseApplyPatch(input), options);
}
