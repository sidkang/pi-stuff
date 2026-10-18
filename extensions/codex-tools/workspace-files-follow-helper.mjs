/**
 * Private Host follow-inside-workspace reader.
 * Spawned with cwd = canonical workspace root. Not a public API.
 *
 * Protocol (stdin JSON request → stdout JSON result):
 * {
 *   relativePath, rootDev, rootIno, read?, maxBytes?, requireSingleLink?, outputPath?
 * }
 *
 * Traverses each canonical directory component via relative lstat + chdir +
 * post-chdir dev/ino verification, then opens the leaf with O_NOFOLLOW|O_NONBLOCK.
 */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { openSync, readSync, closeSync, fstatSync, writeFileSync } from "node:fs";

const HARD_MAX_BYTES = 64 * 1024 * 1024;

const permissionMode = (mode) => mode & 0o7777;
const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const readStdin = async () => {
	const chunks = [];
	let total = 0;
	const MAX_REQUEST = 256 * 1024;
	for await (const chunk of process.stdin) {
		total += chunk.byteLength;
		if (total > MAX_REQUEST) throw new Error("follow helper request exceeded bound");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
};

const fail = (message) => {
	process.stdout.write(JSON.stringify({ ok: false, error: message }));
	process.exitCode = 1;
};

const main = async () => {
	const raw = await readStdin();
	const request = JSON.parse(raw);
	const relativePath = request.relativePath;
	if (
		typeof relativePath !== "string"
		|| !relativePath
		|| relativePath.includes("\0")
		|| relativePath.startsWith("/")
		|| relativePath.includes("\\")
		|| relativePath.includes("//")
		|| relativePath.endsWith("/")
	) {
		throw new Error("relativePath must be a normalized relative path");
	}
	const segments = relativePath.split("/");
	if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))) {
		throw new Error("relativePath must stay inside the workspace");
	}
	if (!isNonNegativeSafeInteger(request.rootDev) || !isNonNegativeSafeInteger(request.rootIno)) {
		throw new Error("root identity must use non-negative safe integers");
	}
	if (typeof request.read !== "boolean" || typeof request.requireSingleLink !== "boolean") {
		throw new Error("follow helper request has invalid boolean fields");
	}
	if (!isNonNegativeSafeInteger(request.maxBytes)) {
		throw new Error("maxBytes must be a non-negative safe integer");
	}

	const rootStat = await fs.lstat(".");
	if (!rootStat.isDirectory()) throw new Error("follow helper cwd is not a directory");
	if (rootStat.dev !== request.rootDev || rootStat.ino !== request.rootIno) {
		throw new Error("follow helper cwd identity mismatch");
	}

	// Walk every directory component except the leaf, rejecting symlinks and races.
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (segment === ".." || segment.includes("\0")) throw new Error("invalid path segment");
		const before = await fs.lstat(segment);
		if (before.isSymbolicLink()) throw new Error("Workspace path contains a symlink during anchored walk");
		if (!before.isDirectory()) throw new Error("Workspace parent is not a directory");
		process.chdir(segment);
		const after = await fs.lstat(".");
		if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()) {
			throw new Error("Workspace parent changed during anchored walk");
		}
	}

	const leaf = segments[segments.length - 1];
	if (leaf === ".." || leaf.includes("\0")) throw new Error("invalid path segment");

	// Probe leaf without following. Prefer open(O_NOFOLLOW) for the final open.
	const leafLstat = await fs.lstat(leaf);
	if (leafLstat.isSymbolicLink()) {
		throw new Error("Workspace path contains a symlink during anchored walk");
	}
	if (leafLstat.isDirectory()) {
		// Directory: chdir + verify, then return metadata (no bytes).
		process.chdir(leaf);
		const after = await fs.lstat(".");
		if (after.dev !== leafLstat.dev || after.ino !== leafLstat.ino || !after.isDirectory()) {
			throw new Error("Workspace directory changed during anchored walk");
		}
		process.stdout.write(JSON.stringify({
			ok: true,
			kind: "directory",
			mode: permissionMode(after.mode),
			dev: after.dev,
			ino: after.ino,
			nlink: after.nlink,
		}));
		return;
	}
	if (!leafLstat.isFile()) throw new Error("Unsupported filesystem entry type");

	const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
	let fd;
	try {
		fd = openSync(leaf, flags);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code === "ELOOP" || code === "EPERM") throw new Error("Workspace path contains a symlink");
		throw error;
	}
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile()) throw new Error("Workspace entry must be a regular file");
		if (opened.dev !== leafLstat.dev || opened.ino !== leafLstat.ino) {
			throw new Error("Workspace entry changed while opening");
		}
		if (request.requireSingleLink === true && opened.nlink !== 1) {
			throw new Error(`Cannot modify hard-linked file; link count is ${opened.nlink}`);
		}
		const maxBytes = Math.min(request.maxBytes, HARD_MAX_BYTES);

		if (request.read === true) {
			if (opened.size > maxBytes) throw new Error(`File exceeds maxBytes (${maxBytes})`);
			const buf = Buffer.alloc(Number(opened.size));
			let offset = 0;
			while (offset < buf.byteLength) {
				const n = readSync(fd, buf, offset, buf.byteLength - offset, offset);
				if (n === 0) break;
				offset += n;
			}
			if (offset !== buf.byteLength) throw new Error("Workspace entry changed while reading");
			const after = fstatSync(fd);
			if (
				!after.isFile()
				|| after.dev !== opened.dev
				|| after.ino !== opened.ino
				|| after.nlink !== opened.nlink
				|| after.mode !== opened.mode
				|| after.size !== opened.size
				|| after.mtimeMs !== opened.mtimeMs
				|| after.ctimeMs !== opened.ctimeMs
			) {
				throw new Error("Workspace entry changed while reading");
			}
			if (typeof request.outputPath !== "string" || !request.outputPath) {
				throw new Error("follow helper outputPath is required for read");
			}
			// Parent-provided exclusive path for materialised bytes.
			writeFileSync(request.outputPath, buf, { flag: "wx", mode: 0o600 });
			process.stdout.write(JSON.stringify({
				ok: true,
				kind: "file",
				mode: permissionMode(after.mode),
				dev: after.dev,
				ino: after.ino,
				nlink: after.nlink,
				size: after.size,
				mtimeMs: after.mtimeMs,
				ctimeMs: after.ctimeMs,
				hasBytes: true,
			}));
			return;
		}

		const after = fstatSync(fd);
		if (
			!after.isFile()
			|| after.dev !== opened.dev
			|| after.ino !== opened.ino
			|| after.nlink !== opened.nlink
			|| after.mode !== opened.mode
			|| after.size !== opened.size
			|| after.mtimeMs !== opened.mtimeMs
			|| after.ctimeMs !== opened.ctimeMs
		) {
			throw new Error("Workspace entry changed while reading");
		}
		process.stdout.write(JSON.stringify({
			ok: true,
			kind: "file",
			mode: permissionMode(after.mode),
			dev: after.dev,
			ino: after.ino,
			nlink: after.nlink,
			size: after.size,
			mtimeMs: after.mtimeMs,
			ctimeMs: after.ctimeMs,
		}));
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
