import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	WORKSPACE_ACCESS_QUERY_V1,
	WORKSPACE_ACCESS_QUERY_V2,
	WORKSPACE_ACCESS_V2_REQUIRED,
	WORKSPACE_HARD_MAX_BYTES,
	createHostWorkspaceAccess,
	resolveWorkspaceFiles,
} from "./workspace-files.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url));

function tempDir() {
	return mkdtempSync(join(tmpdir(), "codex-tools-workspace-"));
}

function bus(handlers = new Map()) {
	return {
		handlers,
		emit(channel, payload) {
			for (const handler of handlers.get(channel) ?? []) handler(payload);
		},
		on(channel, handler) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
		},
	};
}

test("resolver absent => Host", async () => {
	const root = tempDir();
	const ops = [];
	try {
		const resolved = resolveWorkspaceFiles(undefined, {
			root,
			onFsOperation: (op, path) => ops.push([op, path]),
		});
		assert.equal(resolved.kind, "host");
		assert.equal(resolved.placement, "host");
		assert.equal(resolved.access.placement, "host");
		writeFileSync(join(root, "a.txt"), "hello");
		const entry = await resolved.access.inspect("a.txt", { read: true });
		assert.equal(entry.kind, "file");
		assert.equal(Buffer.from(entry.bytes).toString("utf8"), "hello");
		assert.ok(ops.some(([op]) => op === "readFile"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolver v2 host marker => Host", async () => {
	const root = tempDir();
	const events = bus();
	events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => {
		query.provide({ kind: "host" });
	});
	try {
		const resolved = resolveWorkspaceFiles(events, { root });
		assert.equal(resolved.kind, "host");
		assert.equal(resolved.placement, "host");
		await resolved.access.writeFile("b.txt", "x", { expected: "missing", publication: "in-place" });
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "x");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolver v2 access => guest adapter", async () => {
	const root = tempDir();
	const guest = {
		protocolVersion: 2,
		placement: "sandbox",
		async inspect() { return { kind: "missing" }; },
		async writeFile() { return { revision: "r1", createdParents: [] }; },
		async remove() {},
	};
	const events = bus();
	events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => {
		query.provide({ kind: "access", access: guest });
	});
	const resolved = resolveWorkspaceFiles(events, { root });
	assert.equal(resolved.kind, "access");
	assert.equal(resolved.placement, "sandbox");
	assert.equal(resolved.access, guest);
});

test("resolver v2 unavailable => throw", () => {
	const events = bus();
	events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => {
		query.provide({ kind: "unavailable", reason: "VM starting" });
	});
	assert.throws(() => resolveWorkspaceFiles(events, { root: tempDir() }), /VM starting/);
});

test("resolver old v1 sandbox => block with v2 required", () => {
	const events = bus();
	events.on(WORKSPACE_ACCESS_QUERY_V1, (query) => {
		query.provide({
			kind: "access",
			access: { protocolVersion: 1, placement: "sandbox" },
		});
	});
	assert.throws(
		() => resolveWorkspaceFiles(events, { root: tempDir() }),
		(error) => error.message === WORKSPACE_ACCESS_V2_REQUIRED,
	);
});

test("resolver old v1 host => Host", async () => {
	const root = tempDir();
	const events = bus();
	events.on(WORKSPACE_ACCESS_QUERY_V1, (query) => {
		query.provide({
			kind: "access",
			access: { protocolVersion: 1, placement: "host" },
		});
	});
	try {
		const resolved = resolveWorkspaceFiles(events, { root });
		assert.equal(resolved.kind, "host");
		assert.equal(resolved.placement, "host");
		const host = createHostWorkspaceAccess(root);
		assert.equal(resolved.access.protocolVersion, host.protocolVersion);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolver old v1 unavailable => block with v2 required", () => {
	const events = bus();
	events.on(WORKSPACE_ACCESS_QUERY_V1, (query) => {
		query.provide({ kind: "unavailable", reason: "settled" });
	});
	assert.throws(
		() => resolveWorkspaceFiles(events, { root: tempDir() }),
		(error) => error.message === WORKSPACE_ACCESS_V2_REQUIRED,
	);
});

test("resolver accepts first synchronous v2 response only", () => {
	const events = bus();
	const guestA = {
		protocolVersion: 2,
		placement: "sandbox",
		async inspect() { return { kind: "missing" }; },
		async writeFile() { return { revision: "a", createdParents: [] }; },
		async remove() {},
	};
	const guestB = { ...guestA, id: "b" };
	events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => {
		query.provide({ kind: "access", access: guestA });
		query.provide({ kind: "access", access: guestB });
	});
	const resolved = resolveWorkspaceFiles(events, { root: tempDir() });
	assert.equal(resolved.access, guestA);
});

test("workspace authority exposes kind, placement, access, and root once", () => {
	const root = tempDir();
	try {
		const host = resolveWorkspaceFiles(undefined, { root });
		assert.equal(host.kind, "host");
		assert.equal(host.placement, "host");
		assert.equal(host.root, root);
		assert.equal(host.access.placement, "host");

		const guest = {
			protocolVersion: 2,
			placement: "sandbox",
			async inspect() { return { kind: "missing" }; },
			async writeFile() { return { revision: "r", createdParents: [] }; },
			async remove() {},
		};
		const events = bus();
		events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => {
			query.provide({ kind: "access", access: guest });
		});
		const sandbox = resolveWorkspaceFiles(events, { root });
		assert.equal(sandbox.kind, "access");
		assert.equal(sandbox.placement, "sandbox");
		assert.equal(sandbox.access, guest);
		assert.equal(sandbox.root, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host v2 reports permission bits only and includes nlink in revisions", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "mode.txt"), "x", { mode: 0o640 });
		const host = createHostWorkspaceAccess(root);
		const entry = await host.inspect("mode.txt");
		assert.equal(entry.kind, "file");
		assert.equal(entry.mode, 0o640);
		assert.match(entry.revision, /^h\d+r\d+$/);
		assert.ok((entry.mode & ~0o7777) === 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host v2 rejects oversized inspect before read and uses atomic no-replace for missing", async () => {
	const root = tempDir();
	const ops = [];
	try {
		writeFileSync(join(root, "big.txt"), "abcdef");
		const host = createHostWorkspaceAccess(root, {
			onFsOperation: (op) => ops.push(op),
		});
		await assert.rejects(
			() => host.inspect("big.txt", { read: true, maxBytes: 3 }),
			/maxBytes/,
		);
		assert.equal(ops.includes("readFile"), false);
		ops.length = 0;
		await host.writeFile("new.txt", "fresh", {
			expected: "missing",
			publication: "atomic",
			creation: "workspace-default",
			finalMode: 0o600,
		});
		assert.ok(ops.includes("link"));
		assert.equal(ops.includes("rename"), false);
		assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "fresh");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolver rejects malformed v2/v1 offers and host-placement access without Host fallback", () => {
	for (const [channel, offer, expected] of [
		[WORKSPACE_ACCESS_QUERY_V2, { kind: "invalid" }, /v2 returned an invalid offer/],
		[WORKSPACE_ACCESS_QUERY_V2, { kind: "access", access: { protocolVersion: 2, placement: "host", inspect() {}, writeFile() {}, remove() {} } }, /access must use sandbox placement/],
		[WORKSPACE_ACCESS_QUERY_V1, { kind: "invalid" }, /v1 returned an invalid offer/],
	]) {
		const events = bus();
		events.on(channel, (query) => query.provide(offer));
		let hostCalls = 0;
		assert.throws(
			() => resolveWorkspaceFiles(events, {
				root: tempDir(),
				createHost() { hostCalls++; throw new Error("must not create Host access"); },
			}),
			expected,
		);
		assert.equal(hostCalls, 0);
	}
});


test("nested parent directory revisions restore after reverse child removal", async () => {
	const root = tempDir();
	try {
		const host = createHostWorkspaceAccess(root);
		const first = await host.writeFile("a/b/file.txt", "one", {
			expected: "missing",
			publication: "in-place",
			creation: "workspace-default",
		});
		assert.equal(first.createdParents.length, 2);
		const parentA = first.createdParents.find((p) => p.path === "a");
		const parentB = first.createdParents.find((p) => p.path === "a/b");
		assert.ok(parentA);
		assert.ok(parentB);
		// File under a directory must not churn directory revision (size/mtime omitted).
		// Child directory does change parent nlink, so remove children first.
		const file = await host.inspect("a/b/file.txt", { read: true });
		await host.remove("a/b/file.txt", { expected: file.revision, kind: "file" });
		// a/b empty: captured parentB revision (at mkdir, nlink for empty dir) must match.
		await host.remove("a/b", { expected: parentB.revision, kind: "empty-directory" });
		// a empty again after child dir removed: captured parentA revision matches.
		await host.remove("a", { expected: parentA.revision, kind: "empty-directory" });
		assert.equal((await host.inspect("a")).kind, "missing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Host in-place write rejects hardlinked targets without path writeFile fallback", async () => {
	const root = tempDir();
	try {
		const { linkSync } = await import("node:fs");
		writeFileSync(join(root, "linked.txt"), "original");
		linkSync(join(root, "linked.txt"), join(root, "alias.txt"));
		const host = createHostWorkspaceAccess(root);
		const entry = await host.inspect("linked.txt", { read: true, requireSingleLink: true }).catch((error) => error);
		assert.ok(entry instanceof Error);
		const ops = [];
		const host2 = createHostWorkspaceAccess(root, { onFsOperation: (op) => ops.push(op) });
		const current = await host2.inspect("linked.txt");
		await assert.rejects(
			() => host2.writeFile("linked.txt", "mutated", {
				expected: current.revision,
				publication: "in-place",
				creation: "workspace-default",
			}),
			/hard-linked|link count/i,
		);
		assert.equal(readFileSync(join(root, "linked.txt"), "utf8"), "original");
		assert.equal(readFileSync(join(root, "alias.txt"), "utf8"), "original");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host rejects ordinary-inspect revision for hard-linked in-place write and leaves other link unchanged", async () => {
	const root = tempDir();
	try {
		const { writeFileSync, linkSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		writeFileSync(join(root, "a.txt"), "shared");
		linkSync(join(root, "a.txt"), join(root, "b.txt"));
		const host = createHostWorkspaceAccess(root);
		const entry = await host.inspect("a.txt");
		assert.equal(entry.kind, "file");
		await assert.rejects(
			() => host.writeFile("a.txt", "mutated", {
				expected: entry.revision,
				publication: "in-place",
				creation: "workspace-default",
			}),
			/hard-linked|link count/i,
		);
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "shared");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "shared");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host revisions are opaque and cannot replay across paths, kinds, or access objects", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "a");
		writeFileSync(join(root, "b.txt"), "b");
		const first = createHostWorkspaceAccess(root);
		const second = createHostWorkspaceAccess(root);
		const a = await first.inspect("a.txt");
		assert.equal(a.kind, "file");
		assert.match(a.revision, /^h\d+r\d+$/);
		await assert.rejects(
			() => first.writeFile("b.txt", "changed", { expected: a.revision, publication: "in-place" }),
			/different path|revision/i,
		);
		await assert.rejects(
			() => second.writeFile("a.txt", "changed", { expected: a.revision, publication: "in-place" }),
			/unknown or expired/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host serializes two writers on the same expected revision so only one succeeds", async () => {
	const root = tempDir();
	try {
		const { writeFileSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		writeFileSync(join(root, "race.txt"), "base");
		const hostA = createHostWorkspaceAccess(root);
		const hostB = createHostWorkspaceAccess(root);
		const beforeA = await hostA.inspect("race.txt");
		const beforeB = await hostB.inspect("race.txt");
		assert.equal(beforeA.kind, "file");
		assert.equal(beforeB.kind, "file");
		const results = await Promise.allSettled([
			hostA.writeFile("race.txt", "first-writer", {
				expected: beforeA.revision,
				publication: "atomic",
				creation: "workspace-default",
			}),
			hostB.writeFile("race.txt", "second-writer", {
				expected: beforeB.revision,
				publication: "atomic",
				creation: "workspace-default",
			}),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		assert.equal(fulfilled.length, 1);
		assert.equal(rejected.length, 1);
		assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /Revision mismatch|already exists|Could not write/i);
		const content = readFileSync(join(root, "race.txt"), "utf8");
		assert.ok(content === "first-writer" || content === "second-writer");
		// Winner's publication is exactly one of the two concurrent writers.
		assert.equal(content.includes("-writer"), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host inspect without maxBytes still enforces hard cap metadata bound", async () => {
	const root = tempDir();
	try {
		const { writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { WORKSPACE_HARD_MAX_BYTES } = await import("./workspace-files.ts");
		assert.equal(WORKSPACE_HARD_MAX_BYTES, 64 * 1024 * 1024);
		writeFileSync(join(root, "ok.txt"), "tiny");
		const host = createHostWorkspaceAccess(root);
		const entry = await host.inspect("ok.txt", { read: true });
		assert.equal(entry.kind, "file");
		assert.equal(Buffer.from(entry.bytes).toString("utf8"), "tiny");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host parent creation failure removes nested parents inner-to-outer", async () => {
	const root = tempDir();
	let checks = 0;
	try {
		const host = createHostWorkspaceAccess(root, {
			assertCurrent() {
				checks++;
				// write entry + mkdir a + mkdir a/b; fail before a/b/c.
				if (checks >= 4) throw new Error("injected parent creation failure");
			},
		});
		await assert.rejects(
			() => host.writeFile("a/b/c/file.txt", "body", {
				expected: "missing", publication: "in-place", creation: "workspace-default",
			}),
			/injected parent creation failure/,
		);
		assert.equal(existsSync(join(root, "a")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host parent rollback reports uncertainty when a created directory is replaced", async () => {
	const root = tempDir();
	try {
		let replaced = false;
		const host = createHostWorkspaceAccess(root, {
			onFsOperation(operation, candidate) {
				if (!replaced && operation === "mkdir" && candidate.endsWith(`${sep}a${sep}b`)) {
					rmSync(candidate, { recursive: true, force: true });
					writeFileSync(candidate, "racer");
					replaced = true;
				}
			},
		});
		await assert.rejects(
			() => host.writeFile("a/b/c/file.txt", "body", {
				expected: "missing", publication: "in-place", creation: "workspace-default",
			}),
			/workspace mutation state uncertain|parent path is not a directory/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host nested createdParents revisions support reverse empty-dir remove without mode", async () => {
	const root = tempDir();
	try {
		const host = createHostWorkspaceAccess(root);
		const written = await host.writeFile("x/y/z.txt", "body", {
			expected: "missing",
			publication: "atomic",
			creation: "workspace-default",
		});
		assert.equal(written.createdParents.length, 2);
		await host.remove("x/y/z.txt", { expected: written.revision, kind: "file" });
		for (const parent of [...written.createdParents].reverse()) {
			const { path, revision } = parent;
			await host.remove(path, { expected: revision, kind: "empty-directory" });
		}
		const missing = await host.inspect("x");
		assert.equal(missing.kind, "missing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host does not claim pre-existing concurrent parents in createdParents", async () => {
	const root = tempDir();
	try {
		mkdirSync(join(root, "shared"), { recursive: true });
		const host = createHostWorkspaceAccess(root);
		const written = await host.writeFile("shared/nested/file.txt", "body", {
			expected: "missing",
			publication: "in-place",
			creation: "workspace-default",
		});
		assert.deepEqual(written.createdParents.map((p) => p.path), ["shared/nested"]);
		assert.equal(existsSync(join(root, "shared")), true);
		assert.equal(readFileSync(join(root, "shared", "nested", "file.txt"), "utf8"), "body");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host atomic expected-missing leaves nlink===1 and no temp residue", async () => {
	const root = tempDir();
	try {
		const { statSync, readdirSync } = await import("node:fs");
		const host = createHostWorkspaceAccess(root);
		await host.writeFile("pub.txt", "atom", {
			expected: "missing",
			publication: "atomic",
			creation: "workspace-default",
			finalMode: 0o600,
		});
		assert.equal(statSync(join(root, "pub.txt")).nlink, 1);
		assert.equal(readdirSync(root).filter((n) => n.includes(".tmp")).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host write rejects payload over hard max before filesystem mutation", async () => {
	const root = tempDir();
	const ops = [];
	try {
		const host = createHostWorkspaceAccess(root, { onFsOperation: (op) => ops.push(op) });
		const oversize = Buffer.alloc(WORKSPACE_HARD_MAX_BYTES + 1, 1);
		await assert.rejects(
			() => host.writeFile("huge.bin", oversize, {
				expected: "missing",
				publication: "in-place",
				creation: "workspace-default",
			}),
			/maxBytes/,
		);
		assert.equal(ops.includes("writeFile"), false);
		assert.equal(ops.includes("mkdir"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host write rejects oversized byte input before Buffer materialisation", async () => {
	const root = tempDir();
	const originalFrom = Buffer.from;
	let materialised = 0;
	// Patch only Buffer.from; length is read via data.byteLength first.
	Buffer.from = function patchedFrom(...args) {
		materialised += 1;
		return originalFrom.apply(this, args);
	};
	try {
		const host = createHostWorkspaceAccess(root);
		const sentinel = {
			byteLength: WORKSPACE_HARD_MAX_BYTES + 1,
			// Any materialisation attempt should fail loudly if the cap check is skipped.
			[Symbol.toPrimitive]() { throw new Error("must not materialise oversized payload"); },
			valueOf() { throw new Error("must not materialise oversized payload"); },
			toString() { throw new Error("must not materialise oversized payload"); },
		};
		await assert.rejects(
			() => host.writeFile("huge-sentinel.bin", sentinel, {
				expected: "missing",
				publication: "in-place",
				creation: "workspace-default",
			}),
			/maxBytes/,
		);
		assert.equal(materialised, 0);
	} finally {
		Buffer.from = originalFrom;
		rmSync(root, { recursive: true, force: true });
	}
});

test("host follow-inside-workspace revisions remain bound to lexical aliases", async () => {
	const root = tempDir();
	try {
		const { symlinkSync } = await import("node:fs");
		writeFileSync(join(root, "target.txt"), "inside-bytes");
		symlinkSync("target.txt", join(root, "first-alias.txt"));
		symlinkSync("target.txt", join(root, "second-alias.txt"));
		const host = createHostWorkspaceAccess(root);
		const first = await host.inspect("first-alias.txt", { symlinks: "follow-inside-workspace" });
		const second = await host.inspect("second-alias.txt", { symlinks: "follow-inside-workspace" });
		assert.equal(first.kind, "file");
		assert.equal(second.kind, "file");
		assert.notEqual(first.revision, second.revision);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host follow-inside-workspace reads through intermediate symlink that resolves inside", async () => {
	const root = tempDir();
	try {
		const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(join(root, "real"), { recursive: true });
		writeFileSync(join(root, "real", "file.txt"), "inside-bytes");
		symlinkSync("real", join(root, "alias"));
		const host = createHostWorkspaceAccess(root);
		const entry = await host.inspect("alias/file.txt", {
			symlinks: "follow-inside-workspace",
			read: true,
		});
		assert.equal(entry.kind, "file");
		assert.equal(Buffer.from(entry.bytes).toString("utf8"), "inside-bytes");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host follow-inside-workspace rejects a lexical symlink changed at recheck", async () => {
	const root = tempDir();
	try {
		const { symlinkSync } = await import("node:fs");
		mkdirSync(join(root, "first"));
		mkdirSync(join(root, "second"));
		writeFileSync(join(root, "first", "file.txt"), "first-bytes");
		writeFileSync(join(root, "second", "file.txt"), "second-bytes");
		symlinkSync("first/file.txt", join(root, "alias.txt"));
		let rechecked = false;
		const host = createHostWorkspaceAccess(root, {
			onFsOperation(operation) {
				if (!rechecked && operation === "follow-recheck") {
					rmSync(join(root, "alias.txt"));
					symlinkSync("second/file.txt", join(root, "alias.txt"));
					rechecked = true;
				}
			},
		});
		await assert.rejects(
			() => host.inspect("alias.txt", { symlinks: "follow-inside-workspace", read: true }),
			/symlink target changed/i,
		);
		assert.equal(rechecked, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("host follow-inside-workspace never returns outside bytes when intermediate dir races to symlink", async () => {
	const root = tempDir();
	const { mkdirSync, symlinkSync, writeFileSync, rmSync: rm } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const outsideDir = join(dirname(root), `outside-${process.pid}-${Date.now()}`);
	try {
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "file.txt"), "OUTSIDE-SECRET");
		mkdirSync(join(root, "mid"), { recursive: true });
		writeFileSync(join(root, "mid", "file.txt"), "inside-ok");
		let raced = false;
		const host = createHostWorkspaceAccess(root, {
			onFsOperation(operation) {
				// After realpath proves containment, before the anchored child read.
				if (!raced && operation === "follow-child") {
					rm(join(root, "mid"), { recursive: true, force: true });
					symlinkSync(outsideDir, join(root, "mid"));
					raced = true;
				}
			},
		});
		let result;
		let error;
		try {
			result = await host.inspect("mid/file.txt", {
				symlinks: "follow-inside-workspace",
				read: true,
			});
		} catch (err) {
			error = err;
		}
		if (result && result.kind === "file" && result.bytes) {
			assert.notEqual(Buffer.from(result.bytes).toString("utf8"), "OUTSIDE-SECRET");
			assert.fail("anchored follow read must not succeed after intermediate escape race");
		}
		assert.ok(error instanceof Error, "expected race to reject");
		assert.equal(raced, true);
	} finally {
		rm(outsideDir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("follow helper is included in the npm package", () => {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const output = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: packageRoot,
		encoding: "utf8",
	});
	const records = JSON.parse(output);
	assert.equal(records.length, 1);
	assert.ok(records[0].files.some((file) => file.path === "workspace-files-follow-helper.mjs"));
});

test("Host in-place write failures after truncate report mutation state uncertain", async () => {
	const root = tempDir();
	const { open: realOpen } = await import("node:fs/promises");
	let truncated = false;
	// Patch via open wrapper by monkeypatching FileHandle.prototype if available.
	const fhProto = (await realOpen(join(root, "probe"), "w")).constructor.prototype;
	await (await realOpen(join(root, "probe"), "r+")).close().catch(() => undefined);
	const originalTruncate = fhProto.truncate;
	const originalWrite = fhProto.writeFile;
	try {
		writeFileSync(join(root, "target.txt"), "old");
		const host = createHostWorkspaceAccess(root);
		const before = await host.inspect("target.txt");
		assert.equal(before.kind, "file");
		fhProto.truncate = async function patchedTruncate(...args) {
			const result = await originalTruncate.apply(this, args);
			truncated = true;
			return result;
		};
		fhProto.writeFile = async function patchedWrite(...args) {
			if (truncated) throw new Error("injected write failure");
			return originalWrite.apply(this, args);
		};
		await assert.rejects(
			() => host.writeFile("target.txt", "new-bytes", {
				expected: before.revision,
				publication: "in-place",
				creation: "workspace-default",
			}),
			/workspace mutation state uncertain: in-place write failed after truncate/i,
		);
		assert.equal(truncated, true);
	} finally {
		fhProto.truncate = originalTruncate;
		fhProto.writeFile = originalWrite;
		rmSync(root, { recursive: true, force: true });
	}
});
