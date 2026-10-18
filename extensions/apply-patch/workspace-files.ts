/**
 * Structural Workspace Access v2 contract for Codex Tools.
 * Frozen locally to match the Sandbox provider protocol; no Sandbox import.
 */

import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WORKSPACE_ACCESS_QUERY_V2 = "sandbox:workspace-access:query:v2";
export const WORKSPACE_ACCESS_QUERY_V1 = "sandbox:workspace-access:query:v1";

export const WORKSPACE_ACCESS_V2_REQUIRED = "Sandbox Workspace Access v2 is required";
/** Hard read/write payload cap even when maxBytes is omitted. */
export const WORKSPACE_HARD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Process-global per-absolute-path Host mutation queue.
 * Shared across separately loaded apply-patch and Codex Tools copies so same-path
 * writes serialize. Access IDs stay module-local.
 */
const HOST_MUTATION_QUEUES = Symbol.for("sid.pi.workspace-files.host-mutation-queues");
let nextHostAccessId = 0;

function sharedHostMutationQueues(): Map<string, Promise<unknown>> {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[HOST_MUTATION_QUEUES];
	if (existing instanceof Map) return existing as Map<string, Promise<unknown>>;
	const queues = new Map<string, Promise<unknown>>();
	host[HOST_MUTATION_QUEUES] = queues;
	return queues;
}

async function withHostPathLock<T>(absolutePath: string, run: () => Promise<T>): Promise<T> {
	const key = resolve(absolutePath);
	const hostMutationQueues = sharedHostMutationQueues();
	const previous = hostMutationQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const tail = previous.catch(() => undefined).then(() => gate);
	hostMutationQueues.set(key, tail);
	await previous.catch(() => undefined);
	try {
		return await run();
	} finally {
		release();
		if (hostMutationQueues.get(key) === tail) hostMutationQueues.delete(key);
	}
}

/** @internal Test-only same-path Host mutation lock. Not a public API. */
export function withHostPathMutationLockForTests<T>(absolutePath: string, run: () => Promise<T>): Promise<T> {
	return withHostPathLock(absolutePath, run);
}

function effectiveMaxBytes(requested: number | undefined): number {
	if (requested === undefined) return WORKSPACE_HARD_MAX_BYTES;
	if (!Number.isSafeInteger(requested) || requested < 0) {
		throw new Error("Workspace maxBytes must be a non-negative safe integer");
	}
	return Math.min(requested, WORKSPACE_HARD_MAX_BYTES);
}

export type WorkspaceRevision = string;

export type WorkspaceEntry =
	| { readonly kind: "missing" }
	| { readonly kind: "file"; readonly bytes?: Uint8Array; readonly mode: number; readonly revision: WorkspaceRevision }
	| { readonly kind: "directory"; readonly mode: number; readonly revision: WorkspaceRevision };

export type WorkspaceSymlinkPolicy = "reject" | "follow-inside-workspace";
export type WorkspacePublication = "in-place" | "atomic";
export type WorkspaceCreation = "workspace-default" | "owner-private";
export type WorkspaceExpected = "missing" | WorkspaceRevision;
export type WorkspaceRemoveKind = "file" | "empty-directory";

export interface WorkspaceInspectOptions {
	readonly read?: boolean;
	readonly maxBytes?: number;
	readonly symlinks?: WorkspaceSymlinkPolicy;
	readonly requireSingleLink?: boolean;
	readonly signal?: AbortSignal;
}

export interface WorkspaceWriteOptions {
	readonly expected: WorkspaceExpected;
	readonly publication?: WorkspacePublication;
	readonly creation?: WorkspaceCreation;
	readonly finalMode?: number;
	readonly signal?: AbortSignal;
}

export interface WorkspaceRemoveOptions {
	/** Opaque revision token; remove never accepts the synthetic "missing" expected. */
	readonly expected: WorkspaceRevision;
	readonly kind: WorkspaceRemoveKind;
	readonly signal?: AbortSignal;
}

export interface WorkspaceCreatedParent {
	readonly path: string;
	readonly revision: WorkspaceRevision;
}

export interface WorkspaceWriteResult {
	readonly revision: WorkspaceRevision;
	readonly createdParents: readonly WorkspaceCreatedParent[];
}

export interface WorkspaceAccessV2 {
	readonly protocolVersion: 2;
	readonly placement: "sandbox" | "host";
	inspect(path: string, options?: WorkspaceInspectOptions): Promise<WorkspaceEntry>;
	writeFile(path: string, data: string | Uint8Array, options: WorkspaceWriteOptions): Promise<WorkspaceWriteResult>;
	remove(path: string, options: WorkspaceRemoveOptions): Promise<void>;
}

export type WorkspaceAccessOfferV2 =
	| { readonly kind: "access"; readonly access: WorkspaceAccessV2 }
	| { readonly kind: "host" }
	| { readonly kind: "unavailable"; readonly reason: string };

export interface WorkspaceAccessQueryV2 {
	readonly protocolVersion: 2;
	provide(offer: WorkspaceAccessOfferV2): void;
}

/** Structural v1 shapes used only to detect an older loaded Sandbox. */
export interface WorkspaceAccessV1Shape {
	readonly protocolVersion: 1;
	readonly placement: "host" | "sandbox";
}

export type WorkspaceAccessOfferV1Shape =
	| { readonly kind: "access"; readonly access: WorkspaceAccessV1Shape }
	| { readonly kind: "unavailable"; readonly reason: string };

export interface WorkspaceAccessQueryV1Shape {
	readonly protocolVersion: 1;
	provide(offer: WorkspaceAccessOfferV1Shape): void;
}

export interface WorkspaceAccessEvents {
	emit(channel: string, payload: unknown): void;
}

/**
 * Workspace Authority: the once-per-execute resolution of who owns workspace I/O
 * (Host or Sandbox) and the admitted workspace root for that placement.
 * Callers must not re-decide placement or re-implement fail-closed routing.
 */
export type WorkspaceAuthority =
	| {
			readonly kind: "access";
			readonly access: WorkspaceAccessV2;
			readonly placement: "sandbox";
			readonly root: string;
	  }
	| {
			readonly kind: "host";
			readonly access: WorkspaceAccessV2;
			readonly placement: "host";
			readonly root: string;
	  };

export interface HostWorkspaceAccessOptions {
	readonly allowAbsolutePaths?: boolean;
	/** Test seam: observe every Host filesystem primitive. */
	readonly onFsOperation?: (operation: string, path: string) => void;
	readonly assertCurrent?: (signal: AbortSignal | undefined) => void;
}

export interface ResolveWorkspaceFilesOptions {
	readonly root: string;
	readonly signal?: AbortSignal;
	readonly allowAbsolutePaths?: boolean;
	readonly createHost?: (root: string) => WorkspaceAccessV2;
	readonly onFsOperation?: (operation: string, path: string) => void;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Workspace access aborted");
}

function isMissingError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	return code === "ENOENT" || code === "ENOTDIR";
}

function filesystemError(operation: string, pathValue: string, error: unknown): Error {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	const codeText = typeof code === "string" ? ` (${code})` : "";
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Could not ${operation} ${pathValue}${codeText}: ${message}`);
}

export function normalizeWorkspaceRelativePath(filePath: string): string {
	if (!filePath || filePath.includes("\0")) {
		throw new Error("Workspace path must be a non-empty relative path");
	}
	if (isAbsolute(filePath) || filePath.startsWith("/")) {
		throw new Error("Workspace path must be relative");
	}
	const posix = filePath.replace(/\\/g, "/");
	if (posix.includes("//") || posix.endsWith("/")) {
		throw new Error("Workspace path must not contain '..' traversal");
	}
	const segments = posix.split("/");
	if (segments.includes("..") || segments.includes("")) {
		throw new Error("Workspace path must not contain '..' traversal");
	}
	const normalized = segments.filter((segment) => segment !== ".").join("/");
	if (!normalized || normalized === "." || normalized.startsWith("../") || isAbsolute(normalized)) {
		throw new Error("Workspace path must name a file inside the workspace");
	}
	return normalized;
}

/** Public v2 mode is permission bits only (mode & 07777), never full st_mode. */
function permissionMode(mode: number): number {
	return mode & 0o7777;
}

function hostFileRevision(stats: { dev: number; ino: number; mtimeMs: number; ctimeMs: number; size: number; mode: number; nlink: number }): WorkspaceRevision {
	return `f:${stats.dev}:${stats.ino}:${stats.nlink}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${permissionMode(stats.mode)}`;
}

function hostDirectoryRevision(stats: { dev: number; ino: number; mode: number; nlink: number }): WorkspaceRevision {
	// Omit size/mtime/ctime. Keep nlink: capture immediately after each mkdir so
	// outer-parent nlink returns to the captured value after reverse child removal.
	return `d:${stats.dev}:${stats.ino}:${stats.nlink}:${permissionMode(stats.mode)}`;
}

async function lstatOrMissing(pathValue: string, onFs?: HostWorkspaceAccessOptions["onFsOperation"]): Promise<import("node:fs").Stats | undefined> {
	onFs?.("lstat", pathValue);
	try {
		return await lstat(pathValue);
	} catch (error) {
		if (isMissingError(error)) return undefined;
		throw filesystemError("inspect path", pathValue, error);
	}
}

function isInsideRoot(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertNoSymlinkSegments(root: string, absolutePath: string, original: string, onFs?: HostWorkspaceAccessOptions["onFsOperation"]): Promise<void> {
	const rel = relative(root, absolutePath);
	if (rel.startsWith("..") || isAbsolute(rel)) return;
	let current = root;
	for (const segment of rel.split(sep).filter(Boolean)) {
		current = resolve(current, segment);
		const entry = await lstatOrMissing(current, onFs);
		if (entry?.isSymbolicLink()) throw new Error(`Patch path uses a symlink: ${original}`);
	}
}

/** Private follow helper next to this module; not a public API surface. */
const HOST_FOLLOW_HELPER_PATH = fileURLToPath(new URL("./workspace-files-follow-helper.mjs", import.meta.url));
const HOST_FOLLOW_HELPER_REQUEST_MAX = 256 * 1024;
const HOST_FOLLOW_HELPER_STDOUT_MAX = 256 * 1024;
const HOST_FOLLOW_HELPER_STDERR_MAX = 64 * 1024;

type HostFollowHelperResult =
	| {
			readonly ok: true;
			readonly kind: "file";
			readonly mode: number;
			readonly dev: number;
			readonly ino: number;
			readonly nlink: number;
			readonly size: number;
			readonly mtimeMs: number;
			readonly ctimeMs: number;
			readonly hasBytes?: boolean;
	  }
	| {
			readonly ok: true;
			readonly kind: "directory";
			readonly mode: number;
			readonly dev: number;
			readonly ino: number;
			readonly nlink: number;
	  }
	| { readonly ok: false; readonly error: string };

type HostFollowHelperSuccess = Exclude<HostFollowHelperResult, { ok: false }>;

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertHostFollowHelperSuccess(value: unknown): asserts value is HostFollowHelperSuccess {
	if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) {
		throw new Error("follow helper returned an invalid result");
	}
	const result = value as Record<string, unknown>;
	if (
		!isNonNegativeSafeInteger(result.mode) || result.mode > 0o7777
		|| !isNonNegativeSafeInteger(result.dev)
		|| !isNonNegativeSafeInteger(result.ino)
		|| !isNonNegativeSafeInteger(result.nlink) || result.nlink === 0
	) {
		throw new Error("follow helper returned invalid filesystem metadata");
	}
	if (result.kind === "directory") return;
	if (
		result.kind !== "file"
		|| !isNonNegativeSafeInteger(result.size)
		|| typeof result.mtimeMs !== "number" || !Number.isFinite(result.mtimeMs)
		|| typeof result.ctimeMs !== "number" || !Number.isFinite(result.ctimeMs)
		|| (result.hasBytes !== undefined && typeof result.hasBytes !== "boolean")
	) {
		throw new Error("follow helper returned invalid file metadata");
	}
}

async function resolveFollowCanonical(
	root: string,
	absolutePath: string,
	original: string,
	onFs?: HostWorkspaceAccessOptions["onFsOperation"],
): Promise<{ realRoot: string; realTarget: string; relativePath: string; rootDev: number; rootIno: number } | undefined> {
	onFs?.("follow-realpath", root);
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch (error) {
		throw filesystemError("resolve workspace root", root, error);
	}
	onFs?.("follow-realpath", absolutePath);
	let realTarget: string;
	try {
		realTarget = await realpath(absolutePath);
	} catch (error) {
		if (isMissingError(error)) return undefined;
		throw filesystemError("resolve path", absolutePath, error);
	}
	if (!isInsideRoot(realRoot, realTarget)) {
		throw new Error(`path escapes workspace through a symlink: ${original}`);
	}
	const rel = relative(realRoot, realTarget);
	if (rel === "" || rel === ".") {
		throw new Error(`Workspace path must name a file inside the workspace: ${original}`);
	}
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path escapes workspace through a symlink: ${original}`);
	}
	const rootStats = await lstatOrMissing(realRoot, onFs);
	if (!rootStats || !rootStats.isDirectory()) {
		throw new Error("Workspace root is not a directory");
	}
	return {
		realRoot,
		realTarget,
		relativePath: rel.split(sep).join("/"),
		rootDev: rootStats.dev,
		rootIno: rootStats.ino,
	};
}

async function runHostFollowHelper(
	args: {
		readonly realRoot: string;
		readonly relativePath: string;
		readonly rootDev: number;
		readonly rootIno: number;
		readonly read: boolean;
		readonly maxBytes: number;
		readonly requireSingleLink: boolean;
		readonly signal?: AbortSignal;
		readonly onFs?: HostWorkspaceAccessOptions["onFsOperation"];
	},
): Promise<{ result: HostFollowHelperSuccess; bytes?: Uint8Array }> {
	let outputDirectory: string | undefined;
	let operationError: unknown;
	try {
		if (args.read) {
			outputDirectory = await mkdtemp(join(tmpdir(), "codex-wa-follow-"));
			await chmod(outputDirectory, 0o700);
		}
		const outputPath = outputDirectory === undefined ? undefined : join(outputDirectory, "output.bin");
		if (Buffer.byteLength(args.relativePath, "utf8") > HOST_FOLLOW_HELPER_REQUEST_MAX / 2) {
			throw new Error("follow helper request exceeded bound");
		}
		const request = {
			relativePath: args.relativePath,
			rootDev: args.rootDev,
			rootIno: args.rootIno,
			read: args.read,
			maxBytes: args.maxBytes,
			requireSingleLink: args.requireSingleLink,
			...(outputPath === undefined ? {} : { outputPath }),
		};
		const requestJson = JSON.stringify(request);
		if (Buffer.byteLength(requestJson, "utf8") > HOST_FOLLOW_HELPER_REQUEST_MAX) {
			throw new Error("follow helper request exceeded bound");
		}
		const requestBytes = Buffer.from(requestJson, "utf8");
		args.onFs?.("follow-child", args.relativePath);
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let stdoutExceeded = false;
		let stderrExceeded = false;
		const code = await new Promise<number>((resolvePromise, rejectPromise) => {
			let childError: Error | undefined;
			const child = spawn(process.execPath, [HOST_FOLLOW_HELPER_PATH], {
				cwd: args.realRoot,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				stdio: ["pipe", "pipe", "pipe"],
				signal: args.signal,
				windowsHide: true,
			});
			child.stdout?.on("data", (chunk: Buffer) => {
				if (stdoutExceeded) return;
				if (stdout.byteLength + chunk.byteLength > HOST_FOLLOW_HELPER_STDOUT_MAX) {
					stdoutExceeded = true;
					child.kill("SIGKILL");
					return;
				}
				stdout = Buffer.concat([stdout, chunk]);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (stderrExceeded) return;
				if (stderr.byteLength + chunk.byteLength > HOST_FOLLOW_HELPER_STDERR_MAX) {
					stderrExceeded = true;
					child.kill("SIGKILL");
					return;
				}
				stderr = Buffer.concat([stderr, chunk]);
			});
			child.on("error", (error) => {
				childError = error;
			});
			child.on("close", (exitCode) => {
				if (childError) rejectPromise(childError);
				else resolvePromise(exitCode ?? 1);
			});
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(requestBytes);
		});
		throwIfAborted(args.signal);
		if (stdoutExceeded) throw new Error("follow helper stdout exceeded bound");
		if (stderrExceeded) throw new Error("follow helper stderr exceeded bound");
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout.toString("utf8"));
		} catch {
			throw new Error(`follow helper returned invalid JSON${stderr.byteLength ? `: ${stderr.toString("utf8").slice(0, 200)}` : ""}`);
		}
		if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
			const message = parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
				? parsed.error
				: `follow helper failed (exit ${code})`;
			throw new Error(message);
		}
		if (code !== 0) {
			throw new Error(`follow helper exited unsuccessfully (${code})`);
		}
		assertHostFollowHelperSuccess(parsed);
		let bytes: Uint8Array | undefined;
		if (parsed.kind === "file" && args.read) {
			if (parsed.hasBytes !== true || !outputPath) {
				throw new Error("follow helper did not materialise file bytes");
			}
			if (parsed.size > args.maxBytes) {
				throw new Error(`File exceeds maxBytes (${args.maxBytes})`);
			}
			const output = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const before = await output.stat();
				if (!before.isFile() || before.size !== parsed.size || before.size > args.maxBytes) {
					throw new Error(`File exceeds maxBytes (${args.maxBytes}) or changed while reading`);
				}
				const raw = await output.readFile({ signal: args.signal });
				const after = await output.stat();
				if (
					!after.isFile()
					|| after.dev !== before.dev
					|| after.ino !== before.ino
					|| after.nlink !== before.nlink
					|| after.mode !== before.mode
					|| after.size !== before.size
					|| after.mtimeMs !== before.mtimeMs
					|| after.ctimeMs !== before.ctimeMs
					|| raw.byteLength !== before.size
				) {
					throw new Error("follow helper output changed while reading");
				}
				bytes = Uint8Array.from(raw);
			} finally {
				await output.close();
			}
		}
		throwIfAborted(args.signal);
		return { result: parsed, ...(bytes === undefined ? {} : { bytes }) };
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		if (outputDirectory) {
			try {
				await rm(outputDirectory, { recursive: true, force: false });
			} catch (cleanupError) {
				const cleanupMessage = `could not clean private follow helper output: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
				if (operationError) {
					throw new Error(`${operationError instanceof Error ? operationError.message : String(operationError)}; ${cleanupMessage}`, { cause: operationError });
				}
				throw new Error(cleanupMessage, { cause: cleanupError });
			}
		}
	}
}

/**
 * Create the Codex-owned Host Workspace Access v2 adapter.
 * Preserves apply_patch Host path/symlink/hardlink/mode/wx/atomic semantics.
 */
export function createHostWorkspaceAccess(root: string, options: HostWorkspaceAccessOptions = {}): WorkspaceAccessV2 {
	const workspaceRoot = resolve(root);
	const allowAbsolute = options.allowAbsolutePaths === true;
	const onFs = options.onFsOperation;
	const assertCurrent = options.assertCurrent ?? throwIfAborted;
	const accessId = ++nextHostAccessId;
	const revisions = new Map<string, { absolute: string; kind: "file" | "directory"; fingerprint: string }>();
	let nextRevision = 0;
	const issueRevision = (absolute: string, kind: "file" | "directory", fingerprint: string): WorkspaceRevision => {
		for (const [token, bound] of revisions) {
			if (bound.absolute === absolute && bound.kind === kind && bound.fingerprint === fingerprint) return token;
		}
		const token = `h${accessId}r${++nextRevision}`;
		revisions.set(token, { absolute, kind, fingerprint });
		return token;
	};
	const expectedFingerprint = (absolute: string, kind: "file" | "directory", token: WorkspaceRevision): string => {
		const bound = revisions.get(token);
		if (!bound) throw new Error("Workspace revision is unknown or expired");
		if (bound.absolute !== absolute || bound.kind !== kind) {
			throw new Error("Workspace revision is bound to a different path or kind");
		}
		return bound.fingerprint;
	};

	const resolveTarget = (filePath: string): { absolute: string; display: string; relativeUnderRoot: string | undefined } => {
		if (!filePath || filePath.includes("\0")) throw new Error("Workspace path must be a non-empty path");
		if (isAbsolute(filePath)) {
			const absolute = resolve(filePath);
			if (isInsideRoot(workspaceRoot, absolute)) {
				const rel = relative(workspaceRoot, absolute).split(sep).join("/");
				return { absolute, display: filePath, relativeUnderRoot: rel || "." };
			}
			if (!allowAbsolute) throw new Error(`Absolute paths are not allowed: ${filePath}`);
			return { absolute, display: filePath, relativeUnderRoot: undefined };
		}
		const normalized = normalizeWorkspaceRelativePath(filePath);
		const absolute = resolve(workspaceRoot, ...normalized.split("/"));
		if (!isInsideRoot(workspaceRoot, absolute)) throw new Error(`Workspace path escapes the workspace root: ${filePath}`);
		return { absolute, display: filePath, relativeUnderRoot: normalized };
	};

	const currentRevision = async (absolute: string): Promise<{ entry: WorkspaceEntry; stats?: import("node:fs").Stats; fingerprint?: string }> => {
		const stats = await lstatOrMissing(absolute, onFs);
		if (!stats) return { entry: { kind: "missing" } };
		if (stats.isSymbolicLink()) return { entry: { kind: "missing" }, stats };
		if (stats.isDirectory()) {
			const fingerprint = hostDirectoryRevision(stats);
			return { entry: { kind: "directory", mode: permissionMode(stats.mode), revision: issueRevision(absolute, "directory", fingerprint) }, stats, fingerprint };
		}
		if (stats.isFile()) {
			const fingerprint = hostFileRevision(stats);
			return { entry: { kind: "file", mode: permissionMode(stats.mode), revision: issueRevision(absolute, "file", fingerprint) }, stats, fingerprint };
		}
		throw new Error(`Unsupported filesystem entry type at ${absolute}`);
	};

	const assertExpected = async (absolute: string, expected: WorkspaceExpected, display: string): Promise<{ entry: WorkspaceEntry; stats?: import("node:fs").Stats; fingerprint?: string }> => {
		const current = await currentRevision(absolute);
		if (expected === "missing") {
			if (current.entry.kind !== "missing") throw new Error(`Expected missing path: ${display}`);
			return current;
		}
		if (current.entry.kind === "missing") throw new Error(`Expected existing path: ${display}`);
		const kind = current.entry.kind;
		const expectedValue = expectedFingerprint(absolute, kind, expected);
		if (current.fingerprint !== expectedValue) throw new Error(`Revision mismatch for ${display}`);
		return current;
	};

	const readOpenedFile = async (
		absolute: string,
		display: string,
		inspectOptions: WorkspaceInspectOptions,
		maxBytes: number,
		expected?: import("node:fs").Stats,
	): Promise<WorkspaceEntry> => {
		onFs?.("open", absolute);
		const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = await handle.stat();
			if (!opened.isFile()) {
				if (opened.isDirectory()) {
					const fingerprint = hostDirectoryRevision(opened);
					return { kind: "directory", mode: permissionMode(opened.mode), revision: issueRevision(absolute, "directory", fingerprint) };
				}
				throw new Error(`Unsupported filesystem entry type at ${display}`);
			}
			if (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) {
				throw new Error(`Concurrent change detected while reading ${display}.`);
			}
			if (inspectOptions.requireSingleLink && opened.nlink !== 1) {
				throw new Error(`Cannot modify hard-linked file ${display}; link count is ${opened.nlink}.`);
			}
			if (!inspectOptions.read) {
				const fingerprint = hostFileRevision(opened);
				return { kind: "file", mode: permissionMode(opened.mode), revision: issueRevision(absolute, "file", fingerprint) };
			}
			if (opened.size > maxBytes) {
				throw new Error(`File exceeds maxBytes (${maxBytes}): ${display}`);
			}
			onFs?.("readFile", absolute);
			const bytes = await handle.readFile({ signal: inspectOptions.signal });
			assertCurrent(inspectOptions.signal);
			const after = await handle.stat();
			if (
				!after.isFile()
				|| after.dev !== opened.dev
				|| after.ino !== opened.ino
				|| after.nlink !== opened.nlink
				|| after.mode !== opened.mode
				|| after.size !== opened.size
				|| after.mtimeMs !== opened.mtimeMs
				|| after.ctimeMs !== opened.ctimeMs
				|| bytes.byteLength !== opened.size
			) {
				throw new Error(`Concurrent change detected while reading ${display}.`);
			}
			if (bytes.byteLength > maxBytes) {
				throw new Error(`File exceeds maxBytes (${maxBytes}): ${display}`);
			}
			const fingerprint = hostFileRevision(after);
			return {
				kind: "file",
				bytes: Uint8Array.from(bytes),
				mode: permissionMode(after.mode),
				revision: issueRevision(absolute, "file", fingerprint),
			};
		} finally {
			await handle.close();
		}
	};

	const ensureParents = async (
		absolute: string,
		creation: WorkspaceCreation,
		signal: AbortSignal | undefined,
		symlinkPolicy: WorkspaceSymlinkPolicy,
		display: string,
	): Promise<WorkspaceCreatedParent[]> => {
		const created: WorkspaceCreatedParent[] = [];
		const missing: string[] = [];
		let current = dirname(absolute);
		while (true) {
			const stats = await lstatOrMissing(current, onFs);
			if (stats) {
				if (stats.isSymbolicLink() && symlinkPolicy === "reject") throw new Error(`Patch path uses a symlink: ${display}`);
				if (!stats.isDirectory() && !stats.isSymbolicLink()) throw new Error(`Parent path is not a directory: ${current}`);
				break;
			}
			missing.push(current);
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		const cleanupCreated = async (): Promise<void> => {
			const failures: string[] = [];
			for (const parent of [...created].reverse()) {
				const absoluteParent = isAbsolute(parent.path)
					? parent.path
					: resolve(workspaceRoot, ...parent.path.split("/"));
				try {
					const current = await currentRevision(absoluteParent);
					if (current.entry.kind !== "directory" || current.entry.revision !== parent.revision) {
						throw new Error("created parent no longer matches its recorded revision");
					}
					onFs?.("rmdir", absoluteParent);
					await rmdir(absoluteParent);
				} catch (error) {
					failures.push(`${parent.path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (failures.length) throw new Error(`workspace mutation state uncertain: could not prove parent rollback (${failures.join("; ")})`);
		};
		try {
			for (const directory of missing.reverse()) {
				assertCurrent(signal);
				if (symlinkPolicy === "reject" && isInsideRoot(workspaceRoot, directory)) {
					await assertNoSymlinkSegments(workspaceRoot, directory, display, onFs);
				}
				onFs?.("mkdir", directory);
				let createdHere = false;
				try {
					await mkdir(directory, creation === "owner-private" ? { mode: 0o700 } : undefined);
					createdHere = true;
				} catch (error) {
					// Concurrent creator: open/validate but do not claim ownership for rollback.
					if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
						throw filesystemError("create parent directory", directory, error);
					}
				}
				const after = await lstatOrMissing(directory, onFs);
				if (!after || !after.isDirectory()) throw new Error(`Failed to create parent directory: ${directory}`);
				if (createdHere) {
					const rel = isInsideRoot(workspaceRoot, directory) ? relative(workspaceRoot, directory).split(sep).join("/") : directory;
					created.push({ path: rel, revision: issueRevision(directory, "directory", hostDirectoryRevision(after)) });
				}
			}
			return created;
		} catch (error) {
			try {
				await cleanupCreated();
			} catch (cleanupError) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			}
			throw error;
		}
	};

	return {
		protocolVersion: 2,
		placement: "host",
		async inspect(filePath, inspectOptions = {}) {
			assertCurrent(inspectOptions.signal);
			const target = resolveTarget(filePath);
			const symlinkPolicy = inspectOptions.symlinks ?? "reject";
			const maxBytes = effectiveMaxBytes(inspectOptions.maxBytes);

			// follow-inside-workspace: realpath the original lexical path, prove containment,
			// then inspect/read only through a component-anchored child walk. Never absolute-open
			// a realpath result (intermediate symlink races can escape between realpath and open).
			if (symlinkPolicy === "follow-inside-workspace") {
				const resolved = await resolveFollowCanonical(workspaceRoot, target.absolute, target.display, onFs);
				assertCurrent(inspectOptions.signal);
				if (!resolved) return { kind: "missing" };
				const { result, bytes } = await runHostFollowHelper({
					realRoot: resolved.realRoot,
					relativePath: resolved.relativePath,
					rootDev: resolved.rootDev,
					rootIno: resolved.rootIno,
					read: inspectOptions.read === true,
					maxBytes,
					requireSingleLink: inspectOptions.requireSingleLink === true,
					signal: inspectOptions.signal,
					onFs,
				});
				assertCurrent(inspectOptions.signal);
				// Re-resolve the ORIGINAL lexical path; reject if the canonical target moved.
				onFs?.("follow-recheck", target.absolute);
				const again = await resolveFollowCanonical(workspaceRoot, target.absolute, target.display, onFs);
				if (!again || again.realTarget !== resolved.realTarget || again.relativePath !== resolved.relativePath) {
					throw new Error(`Workspace symlink target changed while reading ${target.display}`);
				}
				assertCurrent(inspectOptions.signal);
				// Revisions stay access-local and are based on the stable opened metadata.
				const revisionAbsolute = target.absolute;
				if (result.kind === "directory") {
					const fingerprint = hostDirectoryRevision({
						dev: result.dev,
						ino: result.ino,
						mode: result.mode,
						nlink: result.nlink,
					});
					return {
						kind: "directory",
						mode: permissionMode(result.mode),
						revision: issueRevision(revisionAbsolute, "directory", fingerprint),
					};
				}
				const fingerprint = hostFileRevision({
					dev: result.dev,
					ino: result.ino,
					mtimeMs: result.mtimeMs,
					ctimeMs: result.ctimeMs,
					size: result.size,
					mode: result.mode,
					nlink: result.nlink,
				});
				return bytes === undefined
					? {
						kind: "file",
						mode: permissionMode(result.mode),
						revision: issueRevision(revisionAbsolute, "file", fingerprint),
					}
					: {
						kind: "file",
						bytes,
						mode: permissionMode(result.mode),
						revision: issueRevision(revisionAbsolute, "file", fingerprint),
					};
			}

			if (target.relativeUnderRoot !== undefined) {
				await assertNoSymlinkSegments(workspaceRoot, target.absolute, target.display, onFs);
			}
			const stats = await lstatOrMissing(target.absolute, onFs);
			assertCurrent(inspectOptions.signal);
			if (!stats) return { kind: "missing" };
			if (stats.isSymbolicLink()) {
				throw new Error(`Patch path uses a symlink: ${target.display}`);
			}
			if (stats.isDirectory()) {
				const fingerprint = hostDirectoryRevision(stats);
				return { kind: "directory", mode: permissionMode(stats.mode), revision: issueRevision(target.absolute, "directory", fingerprint) };
			}
			if (!stats.isFile()) throw new Error(`Unsupported filesystem entry type at ${target.display}`);
			if (inspectOptions.requireSingleLink && stats.nlink !== 1) {
				throw new Error(`Cannot modify hard-linked file ${target.display}; link count is ${stats.nlink}.`);
			}
			if (!inspectOptions.read) {
				const fingerprint = hostFileRevision(stats);
				return { kind: "file", mode: permissionMode(stats.mode), revision: issueRevision(target.absolute, "file", fingerprint) };
			}
			return readOpenedFile(target.absolute, target.display, inspectOptions, maxBytes, stats);
		},

		async writeFile(filePath, data, writeOptions) {
			assertCurrent(writeOptions.signal);
			const target = resolveTarget(filePath);
			return withHostPathLock(target.absolute, async () => {
				assertCurrent(writeOptions.signal);
				const publication = writeOptions.publication ?? "in-place";
				const creation = writeOptions.creation ?? "workspace-default";
				// Bound before any full-payload Buffer materialisation / copy.
				const payloadBytes = typeof data === "string"
					? Buffer.byteLength(data, "utf8")
					: data.byteLength;
				if (payloadBytes > WORKSPACE_HARD_MAX_BYTES) {
					throw new Error(`File exceeds maxBytes (${WORKSPACE_HARD_MAX_BYTES}): ${target.display}`);
				}
				const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

				if (target.relativeUnderRoot !== undefined) {
					await assertNoSymlinkSegments(workspaceRoot, target.absolute, target.display, onFs);
				}
				await assertExpected(target.absolute, writeOptions.expected, target.display);

				const createdParents = await ensureParents(target.absolute, creation, writeOptions.signal, "reject", target.display);
				assertCurrent(writeOptions.signal);
				const rollbackCreatedParents = async () => {
					const failures: string[] = [];
					for (const parent of [...createdParents].reverse()) {
						const absoluteParent = isAbsolute(parent.path)
							? parent.path
							: resolve(workspaceRoot, ...parent.path.split("/"));
						try {
							const current = await currentRevision(absoluteParent);
							if (current.entry.kind !== "directory" || current.entry.revision !== parent.revision) {
								throw new Error("created parent no longer matches its recorded revision");
							}
							onFs?.("rmdir", absoluteParent);
							await rmdir(absoluteParent);
						} catch (error) {
							failures.push(`${parent.path}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (failures.length) throw new Error(`workspace mutation state uncertain: could not prove parent rollback (${failures.join("; ")})`);
				};
				let existingInPlaceTruncated = false;

				try {
					if (target.relativeUnderRoot !== undefined) {
						await assertNoSymlinkSegments(workspaceRoot, target.absolute, target.display, onFs);
					}

					const mode = writeOptions.finalMode ?? (creation === "owner-private" ? 0o600 : undefined);

					if (publication === "atomic") {
						const tmpPath = `${target.absolute}.${process.pid}.${Date.now()}.tmp`;
						onFs?.("writeFile", tmpPath);
						const unlinkTempStrict = async () => {
							onFs?.("rm", tmpPath);
							try {
								await rm(tmpPath, { force: false });
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
								throw new Error("workspace mutation state uncertain: could not clean temporary publication file");
							}
						};
						try {
							await writeFile(tmpPath, payload, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
							assertCurrent(writeOptions.signal);
							// Revalidate destination after temp is complete and immediately before publication.
							await assertExpected(target.absolute, writeOptions.expected, target.display);
							if (writeOptions.expected === "missing") {
								// link is true no-replace; rename would overwrite a racing create.
								onFs?.("link", target.absolute);
								await link(tmpPath, target.absolute);
								await unlinkTempStrict();
								const published = await lstatOrMissing(target.absolute, onFs);
								if (!published || !published.isFile() || published.nlink !== 1) {
									throw new Error("workspace mutation state uncertain: published file link count is invalid");
								}
							} else {
								onFs?.("rename", target.absolute);
								await rename(tmpPath, target.absolute);
								// rename consumes the temp; ENOENT cleanup is success.
								await unlinkTempStrict();
							}
						} catch (error) {
							try {
								await unlinkTempStrict();
							} catch (cleanupError) {
								const base = error instanceof Error ? error.message : String(error);
								const extra = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
								throw new Error(`${base}; ${extra}`);
							}
							if (error instanceof Error && error.message.includes("workspace mutation state uncertain")) throw error;
							throw filesystemError("write file", target.display, error);
						}
					} else if (writeOptions.expected === "missing") {
						onFs?.("writeFile", target.absolute);
						try {
							await writeFile(target.absolute, payload, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
						} catch (error) {
							throw filesystemError("add file", target.display, error);
						}
					} else {
						// Existing in-place: open O_NOFOLLOW, revalidate nlink/identity, then mutate same fd.
						onFs?.("open", target.absolute);
						const handle = await open(target.absolute, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
						try {
							const opened = await handle.stat();
							if (!opened.isFile()) throw new Error(`Expected file for in-place write: ${target.display}`);
							if (opened.nlink !== 1) {
								throw new Error(`Cannot modify hard-linked file ${target.display}; link count is ${opened.nlink}.`);
							}
							const openedRevision = hostFileRevision(opened);
							if (openedRevision !== expectedFingerprint(target.absolute, "file", writeOptions.expected)) {
								throw new Error(`Revision mismatch for ${target.display}`);
							}
							const beforeMutation = await handle.stat();
							if (
								beforeMutation.dev !== opened.dev || beforeMutation.ino !== opened.ino ||
								beforeMutation.nlink !== opened.nlink || beforeMutation.mode !== opened.mode ||
								beforeMutation.size !== opened.size || beforeMutation.mtimeMs !== opened.mtimeMs ||
								beforeMutation.ctimeMs !== opened.ctimeMs
							) throw new Error(`workspace mutation state uncertain: target changed before write: ${target.display}`);
							let truncated = false;
							try {
								await handle.truncate(0);
								truncated = true;
								existingInPlaceTruncated = true;
								await handle.writeFile(payload);
								if (writeOptions.finalMode !== undefined) {
									await handle.chmod(permissionMode(writeOptions.finalMode));
								}
								const afterMutation = await handle.stat();
								const named = await lstatOrMissing(target.absolute, onFs);
								if (!named || !named.isFile() || named.dev !== afterMutation.dev || named.ino !== afterMutation.ino) {
									throw new Error(`workspace mutation state uncertain: target was replaced during write: ${target.display}`);
								}
							} catch (error) {
								if (truncated) {
									const detail = error instanceof Error ? error.message : String(error);
									throw new Error(
										`workspace mutation state uncertain: in-place write failed after truncate: ${detail}`,
										{ cause: error },
									);
								}
								throw error;
							}
						} finally {
							await handle.close();
						}
					}

					assertCurrent(writeOptions.signal);
					let after = await lstatOrMissing(target.absolute, onFs);
					if (!after || !after.isFile()) throw new Error(`Post-write path is not a file: ${target.display}`);

					if (writeOptions.finalMode !== undefined && permissionMode(after.mode) !== permissionMode(writeOptions.finalMode)) {
						onFs?.("chmod", target.absolute);
						try {
							await chmod(target.absolute, permissionMode(writeOptions.finalMode));
						} catch (error) {
							throw filesystemError("set permissions for", target.display, error);
						}
						after = await lstatOrMissing(target.absolute, onFs);
						if (!after || !after.isFile()) throw new Error(`Post-chmod path is not a file: ${target.display}`);
					}

					return {
						revision: issueRevision(target.absolute, "file", hostFileRevision(after)),
						createdParents,
					};
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					const reported = existingInPlaceTruncated && !detail.includes("workspace mutation state uncertain")
						? new Error(`workspace mutation state uncertain: in-place write failed after truncate: ${detail}`, { cause: error })
						: error;
					try {
						await rollbackCreatedParents();
					} catch (cleanupError) {
						throw new Error(`${reported instanceof Error ? reported.message : String(reported)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
					}
					throw reported;
				}
			});
		},

		async remove(filePath, removeOptions) {
			assertCurrent(removeOptions.signal);
			const target = resolveTarget(filePath);
			return withHostPathLock(target.absolute, async () => {
				assertCurrent(removeOptions.signal);
				if (target.relativeUnderRoot !== undefined) {
					await assertNoSymlinkSegments(workspaceRoot, target.absolute, target.display, onFs);
				}
				const current = await assertExpected(target.absolute, removeOptions.expected, target.display);
				// Immediate revalidation before destructive unlink/rmdir.
				const again = await assertExpected(target.absolute, removeOptions.expected, target.display);
				if (removeOptions.kind === "file") {
					if (again.entry.kind !== "file") throw new Error(`Expected file for remove: ${target.display}`);
					if (again.stats && again.stats.nlink !== 1) {
						throw new Error(`Cannot modify hard-linked file ${target.display}; link count is ${again.stats.nlink}.`);
					}
					if (
						current.stats && again.stats &&
						(current.stats.dev !== again.stats.dev || current.stats.ino !== again.stats.ino)
					) {
						throw new Error(`Revision mismatch for ${target.display}`);
					}
					onFs?.("rm", target.absolute);
					try {
						await rm(target.absolute, { force: false, recursive: false });
					} catch (error) {
						throw filesystemError("delete file", target.display, error);
					}
				} else {
					if (again.entry.kind !== "directory") throw new Error(`Expected empty directory for remove: ${target.display}`);
					onFs?.("rmdir", target.absolute);
					try {
						await rmdir(target.absolute);
					} catch (error) {
						throw filesystemError("remove created directory", target.display, error);
					}
				}
				assertCurrent(removeOptions.signal);
			});
		},
	};
}

function isWorkspaceAccessOfferV2(value: unknown): value is WorkspaceAccessOfferV2 {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<WorkspaceAccessOfferV2> & { access?: Partial<WorkspaceAccessV2> };
	if (candidate.kind === "host") return true;
	if (candidate.kind === "unavailable" && typeof (candidate as { reason?: unknown }).reason === "string") return true;
	if (candidate.kind === "access" && candidate.access && candidate.access.protocolVersion === 2) {
		const placement = candidate.access.placement;
		if (placement !== "sandbox" && placement !== "host") return false;
		return typeof candidate.access.inspect === "function"
			&& typeof candidate.access.writeFile === "function"
			&& typeof candidate.access.remove === "function";
	}
	return false;
}

function isWorkspaceAccessOfferV1Shape(value: unknown): value is WorkspaceAccessOfferV1Shape {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<WorkspaceAccessOfferV1Shape> & { access?: Partial<WorkspaceAccessV1Shape> };
	if (candidate.kind === "unavailable" && typeof (candidate as { reason?: unknown }).reason === "string") return true;
	if (candidate.kind === "access" && candidate.access && candidate.access.protocolVersion === 1) {
		return candidate.access.placement === "host" || candidate.access.placement === "sandbox";
	}
	return false;
}

/** Map an absolute path under root to a workspace-relative posix path; reject outside for sandbox. */
export function toWorkspaceRelativePath(
	absolutePath: string,
	root: string,
	placement: "host" | "sandbox",
	allowAbsolutePaths = false,
): string {
	const resolvedRoot = resolve(root);
	const resolved = resolve(absolutePath);
	const rel = relative(resolvedRoot, resolved);
	if (rel === "") return ".";
	if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
	if (placement === "sandbox") throw new Error(`Patch path escapes cwd: ${absolutePath}`);
	if (!allowAbsolutePaths) throw new Error(`Absolute paths are not allowed: ${absolutePath}`);
	return resolved;
}

function createWorkspaceAuthority(
	base: { kind: "access"; access: WorkspaceAccessV2; placement: "sandbox" } | { kind: "host"; access: WorkspaceAccessV2; placement: "host" },
	root: string,
): WorkspaceAuthority {
	return {
		...base,
		root: resolve(root),
	};
}

/**
 * Resolve Workspace Authority once per tool execute. Never cache across executions.
 *
 * 1. emit v2; accept first synchronous response
 * 2. access => exact Sandbox adapter; host => own Host; unavailable => throw
 * 3. if v2 silent, emit v1 only to detect older/loaded Sandbox
 *    - v1 host placement => own Host
 *    - v1 sandbox placement or unavailable => hard error (no Host fallback)
 * 4. both silent => Sandbox absent => own Host
 */
export function resolveWorkspaceFiles(
	events: WorkspaceAccessEvents | undefined,
	options: ResolveWorkspaceFilesOptions,
): WorkspaceAuthority {
	const createHost = options.createHost ?? ((root: string) => createHostWorkspaceAccess(root, {
		allowAbsolutePaths: options.allowAbsolutePaths,
		onFsOperation: options.onFsOperation,
	}));

	if (!events) {
		return createWorkspaceAuthority(
			{ kind: "host", placement: "host", access: createHost(options.root) },
			options.root,
		);
	}

	let v2Responded = false;
	let v2Offer: WorkspaceAccessOfferV2 | undefined;
	const queryV2: WorkspaceAccessQueryV2 = {
		protocolVersion: 2,
		provide(offer) {
			if (v2Responded) return;
			v2Responded = true;
			if (!isWorkspaceAccessOfferV2(offer)) {
				throw new Error("Sandbox Workspace Access v2 returned an invalid offer");
			}
			if (offer.kind === "access" && offer.access.placement !== "sandbox") {
				throw new Error("Sandbox Workspace Access v2 access must use sandbox placement");
			}
			v2Offer = offer;
		},
	};
	events.emit(WORKSPACE_ACCESS_QUERY_V2, queryV2);

	if (v2Responded) {
		if (!v2Offer) throw new Error("Sandbox Workspace Access v2 returned an invalid offer");
		if (v2Offer.kind === "unavailable") throw new Error(v2Offer.reason);
		if (v2Offer.kind === "host") {
			return createWorkspaceAuthority(
				{ kind: "host", placement: "host", access: createHost(options.root) },
				options.root,
			);
		}
		return createWorkspaceAuthority(
			{ kind: "access", placement: "sandbox", access: v2Offer.access },
			options.root,
		);
	}

	let v1Responded = false;
	let v1Offer: WorkspaceAccessOfferV1Shape | undefined;
	const queryV1: WorkspaceAccessQueryV1Shape = {
		protocolVersion: 1,
		provide(offer) {
			if (v1Responded) return;
			v1Responded = true;
			if (!isWorkspaceAccessOfferV1Shape(offer)) {
				throw new Error("Sandbox Workspace Access v1 returned an invalid offer");
			}
			v1Offer = offer;
		},
	};
	events.emit(WORKSPACE_ACCESS_QUERY_V1, queryV1);

	if (v1Responded) {
		if (!v1Offer) throw new Error("Sandbox Workspace Access v1 returned an invalid offer");
		if (v1Offer.kind === "unavailable") throw new Error(WORKSPACE_ACCESS_V2_REQUIRED);
		if (v1Offer.access.placement === "host") {
			return createWorkspaceAuthority(
				{ kind: "host", placement: "host", access: createHost(options.root) },
				options.root,
			);
		}
		throw new Error(WORKSPACE_ACCESS_V2_REQUIRED);
	}

	return createWorkspaceAuthority(
		{ kind: "host", placement: "host", access: createHost(options.root) },
		options.root,
	);
}

export function workspacePathJoin(...parts: string[]): string {
	return join(...parts).split(sep).join("/");
}
