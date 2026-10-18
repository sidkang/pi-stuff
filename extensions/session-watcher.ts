import { closeSync, openSync, readFileSync, readSync, statSync, unwatchFile, watchFile, type StatWatcher, type Stats } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "session-watcher";
const QUIET_MS = 20_000;
const WATCH_INTERVAL_MS = 10_000;
const MAX_HEADER_BYTES = 64 * 1024;

type Timer = ReturnType<typeof setTimeout>;

type WatchListener = (curr: Stats, prev: Stats) => void;

interface RuntimeDeps {
	watchFile(file: string, options: { interval: number }, listener: WatchListener): StatWatcher;
	unwatchFile(file: string, listener?: WatchListener): void;
	statFile(file: string): Pick<Stats, "mtimeMs" | "size">;
	setTimeout(callback: () => void, ms: number): Timer;
	clearTimeout(timer: Timer): void;
}

interface SessionSnapshot {
	sessionId: string;
	entryIds: string[];
}

interface FileStatSnapshot {
	mtimeMs: number;
	size: number;
}

const defaultDeps: RuntimeDeps = {
	watchFile,
	unwatchFile,
	statFile: statSync,
	setTimeout,
	clearTimeout,
};

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error ?? "unknown error");
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readFirstLine(file: string): string | null {
	const fd = openSync(file, "r");
	try {
		const decoder = new StringDecoder("utf8");
		let total = 0;
		let pending = "";
		const buffer = Buffer.allocUnsafe(4096);
		while (total < MAX_HEADER_BYTES) {
			const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_HEADER_BYTES - total), null);
			if (bytesRead === 0) break;
			total += bytesRead;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			const newline = pending.indexOf("\n");
			if (newline !== -1) return pending.slice(0, newline).replace(/\r$/, "");
		}
		pending += decoder.end();
		return pending.length > 0 ? pending.replace(/\r$/, "") : null;
	} finally {
		closeSync(fd);
	}
}

function parseSessionHeaderId(line: string | undefined): string | null {
	try {
		if (!line?.trim()) return null;
		const header = JSON.parse(line.replace(/\r$/, "")) as { type?: unknown; id?: unknown };
		if (header.type !== "session" || typeof header.id !== "string") return null;
		return header.id;
	} catch {
		return null;
	}
}

export function readSessionHeaderId(file: string): string | null {
	try {
		return parseSessionHeaderId(readFirstLine(file) ?? undefined);
	} catch {
		return null;
	}
}

export function readDiskSnapshotForSession(file: string, expectedSessionId: string): SessionSnapshot | null {
	const sessionId = readSessionHeaderId(file);
	if (sessionId !== expectedSessionId) return null;

	try {
		const content = readFileSync(file, "utf8");
		const lines = content.split(/\r?\n/);
		const snapshotSessionId = parseSessionHeaderId(lines[0]);
		if (snapshotSessionId !== expectedSessionId) return null;

		const entryIds: string[] = [];
		const seenIds = new Set<string>();

		for (let index = 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line.trim()) continue;
			const entry = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (entry.type === "session") return null;
			if (typeof entry.id !== "string") return null;
			if (seenIds.has(entry.id)) return null;
			seenIds.add(entry.id);
			entryIds.push(entry.id);
		}

		return { sessionId: snapshotSessionId, entryIds };
	} catch {
		return null;
	}
}

function readMemorySnapshot(ctx: ExtensionContext): SessionSnapshot | null {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) return null;

	const entryIds: string[] = [];
	const seenIds = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries() as SessionEntry[]) {
		if (!entry || typeof entry.id !== "string") return null;
		if (seenIds.has(entry.id)) return null;
		seenIds.add(entry.id);
		entryIds.push(entry.id);
	}
	return { sessionId, entryIds };
}

export function isStrictPrefix(prefix: string[], full: string[]): boolean {
	return prefix.length < full.length && prefix.every((id, index) => full[index] === id);
}

export function shouldReloadFromSnapshots(memory: SessionSnapshot, disk: SessionSnapshot): boolean {
	if (memory.sessionId !== disk.sessionId) return false;
	return isStrictPrefix(memory.entryIds, disk.entryIds);
}

function shouldReloadCurrentSession(ctx: ExtensionContext, file: string): boolean {
	const memory = readMemorySnapshot(ctx);
	if (!memory) return false;
	const disk = readDiskSnapshotForSession(file, memory.sessionId);
	if (!disk) return false;
	return shouldReloadFromSnapshots(memory, disk);
}

function toFileStatSnapshot(stats: Pick<Stats, "mtimeMs" | "size">): FileStatSnapshot {
	return { mtimeMs: stats.mtimeMs, size: stats.size };
}

function readFileStatSnapshot(deps: RuntimeDeps, file: string): FileStatSnapshot | null {
	try {
		return toFileStatSnapshot(deps.statFile(file));
	} catch {
		return null;
	}
}

function sameFileStat(a: FileStatSnapshot, b: FileStatSnapshot): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isStatChange(curr: Stats, prev: Stats): boolean {
	return curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size;
}

export function registerSessionWatcher(pi: ExtensionAPI, deps: RuntimeDeps = defaultDeps): void {
	let watchedFile: string | undefined;
	let watchListener: WatchListener | undefined;
	let quietTimer: Timer | undefined;
	let generation = 0;

	function stopWatching(): void {
		generation += 1;
		if (quietTimer) {
			deps.clearTimeout(quietTimer);
			quietTimer = undefined;
		}
		if (watchedFile && watchListener) {
			deps.unwatchFile(watchedFile, watchListener);
		}
		watchedFile = undefined;
		watchListener = undefined;
	}

	function shutdownWhenAdvanced(ctx: ExtensionContext, file: string): void {
		const currentStat = readFileStatSnapshot(deps, file);
		if (!currentStat) return;
		if (!shouldReloadCurrentSession(ctx, file)) return;

		ctx.ui.notify?.(`${EXTENSION_ID}: session advanced on disk; exiting. Reopen with: pi --session ${shellEscape(file)}`, "info");
		stopWatching();
		ctx.shutdown?.();
	}

	function checkAndShutdown(ctx: ExtensionContext, baseline: FileStatSnapshot, checkGeneration: number): void {
		if (checkGeneration !== generation) return;
		if (!ctx.isIdle()) return;

		const file = ctx.sessionManager.getSessionFile();
		if (!file || file !== watchedFile) return;

		const currentStat = readFileStatSnapshot(deps, file);
		if (!currentStat) return;
		if (!sameFileStat(currentStat, baseline)) {
			scheduleQuietCheck(ctx, currentStat);
			return;
		}

		shutdownWhenAdvanced(ctx, file);
	}

	function scheduleQuietCheck(ctx: ExtensionContext, baseline: FileStatSnapshot): void {
		if (quietTimer) deps.clearTimeout(quietTimer);
		const checkGeneration = generation;
		quietTimer = deps.setTimeout(() => {
			quietTimer = undefined;
			try {
				checkAndShutdown(ctx, baseline, checkGeneration);
			} catch (error) {
				ctx.ui.notify?.(`${EXTENSION_ID}: failed to inspect session file: ${getErrorMessage(error)}`, "warning");
			}
		}, QUIET_MS);
	}

	function startIdleWatching(ctx: ExtensionContext): void {
		stopWatching();

		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;

		const baseline = readFileStatSnapshot(deps, file);
		if (!baseline) return;

		watchedFile = file;
		watchListener = (curr, prev) => {
			if (!isStatChange(curr, prev)) return;
			scheduleQuietCheck(ctx, toFileStatSnapshot(curr));
		};
		deps.watchFile(file, { interval: WATCH_INTERVAL_MS }, watchListener);
		// Catch changes that landed while the watcher was stopped or just before its baseline was registered.
		scheduleQuietCheck(ctx, baseline);
	}

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		startIdleWatching(ctx);
	});

	pi.on("before_agent_start", async () => {
		stopWatching();
	});

	pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
		startIdleWatching(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopWatching();
	});
}

export default function sessionWatcher(pi: ExtensionAPI): void {
	registerSessionWatcher(pi);
}

export const __test = {
	EXTENSION_ID,
	QUIET_MS,
	WATCH_INTERVAL_MS,
	readMemorySnapshot,
	shouldReloadCurrentSession,
	isStatChange,
	sameFileStat,
};
