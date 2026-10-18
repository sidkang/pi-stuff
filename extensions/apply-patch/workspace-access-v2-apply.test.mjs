import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stubModules = new Map([
	["@earendil-works/pi-coding-agent", `
    export function keyHint(_key, description) { return description; }
    export function renderDiff(value) { return value; }
    export async function withFileMutationQueue(_path, fn) { return fn(); }
    export function generateDiffString(oldText, newText) {
      return { diff: oldText === newText ? "" : "- " + oldText + "\\n+ " + newText, firstChangedLine: 1 };
    }
    export function generateUnifiedPatch(path, oldText, newText) {
      return oldText === newText ? "" : "--- " + path + "\\n+++ " + path + "\\n-" + oldText + "\\n+" + newText;
    }
  `],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (stubModules.has(specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("stub:")) return { format: "module", source: stubModules.get(url.slice("stub:".length)), shortCircuit: true };
		return nextLoad(url, context);
	},
});

const { applyPatch } = await import("./apply-patch.ts");
const { createHostWorkspaceAccess } = await import("./workspace-files.ts");

function patch(body) {
	return `*** Begin Patch\n${body}\n*** End Patch`;
}

function createMemoryWorkspaceAccess(initial = {}) {
	/** @type {Map<string, { kind: "file", bytes: Uint8Array, mode: number, revision: string } | { kind: "directory", mode: number, revision: string }>} */
	const store = new Map();
	let rev = 0;
	const nextRev = (prefix) => `${prefix}:${++rev}`;
	const hostOps = [];

	for (const [path, value] of Object.entries(initial)) {
		if (typeof value === "string" || value instanceof Uint8Array) {
			const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
			store.set(path, { kind: "file", bytes: Uint8Array.from(bytes), mode: 0o644, revision: nextRev("f") });
		}
	}

	function ensureParents(path) {
		const created = [];
		const parts = path.split("/").filter(Boolean);
		let current = "";
		for (let i = 0; i < parts.length - 1; i++) {
			current = current ? `${current}/${parts[i]}` : parts[i];
			const existing = store.get(current);
			if (existing?.kind === "file") throw new Error(`Parent path is not a directory: ${current}`);
			if (!existing) {
				const revision = nextRev("d");
				store.set(current, { kind: "directory", mode: 0o755, revision });
				created.push({ path: current, revision, mode: 0o755 });
			}
		}
		return created;
	}

	const access = {
		protocolVersion: 2,
		placement: "sandbox",
		async inspect(path, options = {}) {
			if (options.symlinks === "reject" && path.includes("link/")) {
				throw new Error(`Patch path uses a symlink: ${path}`);
			}
			const entry = store.get(path);
			if (!entry) return { kind: "missing" };
			if (entry.kind === "directory") return { kind: "directory", mode: entry.mode, revision: entry.revision };
			if (options.requireSingleLink && path.includes("hardlink")) {
				throw new Error(`Cannot modify hard-linked file ${path}; link count is 2.`);
			}
			if (!options.read) return { kind: "file", mode: entry.mode, revision: entry.revision };
			return { kind: "file", bytes: entry.bytes, mode: entry.mode, revision: entry.revision };
		},
		async writeFile(path, data, options) {
			const current = store.get(path);
			if (options.expected === "missing") {
				if (current) throw new Error(`Expected missing path: ${path}`);
			} else if (!current || current.kind !== "file" || current.revision !== options.expected) {
				throw new Error(`Revision mismatch for ${path}`);
			}
			const createdParents = ensureParents(path);
			const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
			const revision = nextRev("f");
			const mode = options.finalMode ?? (options.creation === "owner-private" ? 0o600 : 0o644);
			store.set(path, { kind: "file", bytes: Uint8Array.from(bytes), mode, revision });
			return { revision, createdParents };
		},
		async remove(path, options) {
			const current = store.get(path);
			if (!current) throw new Error(`Expected existing path: ${path}`);
			if (current.revision !== options.expected) throw new Error(`Revision mismatch for ${path}`);
			if (options.kind === "file" && current.kind !== "file") throw new Error(`Expected file for remove: ${path}`);
			if (options.kind === "empty-directory" && current.kind !== "directory") throw new Error(`Expected empty directory for remove: ${path}`);
			store.delete(path);
		},
		_store: store,
		_hostOps: hostOps,
	};

	// Attach a host adapter spy that must never be used.
	const host = createHostWorkspaceAccess(mkdtempSync(join(tmpdir(), "unused-host-")), {
		onFsOperation: (op, path) => hostOps.push([op, path]),
	});
	access._host = host;
	return access;
}

test("fake v2 adapter applies add/update/delete/move with zero Host fs workspace ops", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-apply-"));
	const access = createMemoryWorkspaceAccess({
		"update.txt": "alpha\nold\nomega",
		"delete.txt": "remove",
	});
	try {
		const result = await applyPatch(
			patch(`*** Add File: nested/added.txt\n+hello\n+world\n*** Update File: update.txt\n@@\n alpha\n-old\n+new\n omega\n*** Delete File: delete.txt\n*** Update File: update.txt\n*** Move to: moved.txt\n@@\n alpha\n-new\n+newer\n omega`),
			{ cwd, workspace: access, workspacePlacement: "sandbox" },
		);
		assert.equal(Buffer.from(access._store.get("nested/added.txt").bytes).toString("utf8"), "hello\nworld\n");
		assert.equal(Buffer.from(access._store.get("moved.txt").bytes).toString("utf8"), "alpha\nnewer\nomega");
		assert.equal(access._store.has("update.txt"), false);
		assert.equal(access._store.has("delete.txt"), false);
		assert.ok(result.changedFiles.includes("moved.txt"));
		assert.deepEqual(access._hostOps, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("fake v2 adapter treats unique identical update as noop", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-noop-"));
	const access = createMemoryWorkspaceAccess({ "same.txt": "same\n" });
	try {
		const result = await applyPatch(patch("*** Update File: same.txt\n@@\n-same\n+same"), {
			cwd,
			workspace: access,
			workspacePlacement: "sandbox",
		});
		assert.equal(result.changedFiles.length, 0);
		assert.equal(result.noops.length, 1);
		assert.deepEqual(access._hostOps, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("fake v2 adapter rolls back created files on later failure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-rollback-"));
	const access = createMemoryWorkspaceAccess({
		"keep.txt": "secret",
	});
	// Force second write to fail by making parent path a file after first mutation via afterMutation.
	try {
		await assert.rejects(
			() => applyPatch(
				patch("*** Add File: nested/ok.txt\n+ok\n*** Add File: z-parent/child.txt\n+fail"),
				{
					cwd,
					workspace: access,
					workspacePlacement: "sandbox",
					afterMutation: (absolutePath, operation) => {
						if (operation === "add" && absolutePath.endsWith("nested/ok.txt")) {
							// Plant a non-directory parent for the later path.
							access._store.set("z-parent", {
								kind: "file",
								bytes: Uint8Array.from(Buffer.from("not a directory")),
								mode: 0o644,
								revision: "block",
							});
						}
					},
				},
			),
			/Rolled back all touched files|rollback/i,
		);
		assert.equal(access._store.has("nested/ok.txt"), false);
		assert.equal(Buffer.from(access._store.get("keep.txt").bytes).toString("utf8"), "secret");
		assert.deepEqual(access._hostOps, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("fake v2 adapter honors abort before mutation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-abort-"));
	const access = createMemoryWorkspaceAccess();
	const controller = new AbortController();
	controller.abort();
	try {
		await assert.rejects(
			() => applyPatch(patch("*** Add File: aborted.txt\n+nope"), {
				cwd,
				workspace: access,
				workspacePlacement: "sandbox",
				signal: controller.signal,
			}),
			/aborted/i,
		);
		assert.equal(access._store.has("aborted.txt"), false);
		assert.deepEqual(access._hostOps, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("fake v2 adapter rolls back nested parents with stable directory revisions", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-nested-rollback-"));
	const access = createMemoryWorkspaceAccess({ "keep.txt": "keep" });
	// Make directory revisions stable like Host/Guest (identity, not per-child rev).
	const originalWrite = access.writeFile.bind(access);
	access.writeFile = async (path, data, options) => {
		const result = await originalWrite(path, data, options);
		// Keep created parent revisions fixed even if later children appear.
		return result;
	};
	try {
		await assert.rejects(
			() => applyPatch(
				patch("*** Add File: deep/nested/ok.txt\n+ok\n*** Add File: zzz/block.txt\n+nope"),
				{
					cwd,
					workspace: access,
					workspacePlacement: "sandbox",
					afterMutation: (absolutePath, operation) => {
						if (operation === "add" && absolutePath.endsWith("deep/nested/ok.txt")) {
							access._store.set("zzz", {
								kind: "file",
								bytes: Uint8Array.from(Buffer.from("not a directory")),
								mode: 0o644,
								revision: "block",
							});
						}
					},
				},
			),
			/Rolled back all touched files|rollback/i,
		);
		assert.equal(access._store.has("deep/nested/ok.txt"), false);
		assert.equal(access._store.has("deep/nested"), false);
		assert.equal(access._store.has("deep"), false);
		assert.equal(Buffer.from(access._store.get("keep.txt").bytes).toString("utf8"), "keep");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("fake v2 adapter rolls back after mid-mutation abort without inheriting aborted signal", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-abort-rollback-"));
	const access = createMemoryWorkspaceAccess();
	const controller = new AbortController();
	try {
		await assert.rejects(
			() => applyPatch(
				patch("*** Add File: nested/ok.txt\n+ok\n*** Add File: nested/later.txt\n+later"),
				{
					cwd,
					workspace: access,
					workspacePlacement: "sandbox",
					signal: controller.signal,
					afterMutation: (absolutePath, operation) => {
						if (operation === "add" && absolutePath.endsWith("nested/ok.txt")) {
							controller.abort();
						}
					},
				},
			),
			/aborted|Rolled back all touched files/i,
		);
		assert.equal(access._store.has("nested/ok.txt"), false);
		assert.equal(access._store.has("nested/later.txt"), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("apply_patch rollback accepts createdParents without mode (sandbox public shape)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-parent-mode-"));
	const access = createMemoryWorkspaceAccess({ "keep.txt": "keep" });
	// Force public createdParents to omit mode while keeping Host-compatible internal modes.
	const originalWrite = access.writeFile.bind(access);
	access.writeFile = async (path, data, options) => {
		const result = await originalWrite(path, data, options);
		return {
			revision: result.revision,
			createdParents: result.createdParents.map(({ path: parentPath, revision }) => ({ path: parentPath, revision })),
		};
	};
	try {
		await assert.rejects(
			() => applyPatch(
				patch("*** Add File: deep/nested/ok.txt\n+ok\n*** Add File: zzz/block.txt\n+nope"),
				{
					cwd,
					workspace: access,
					workspacePlacement: "sandbox",
					afterMutation: (absolutePath, operation) => {
						if (operation === "add" && absolutePath.endsWith("deep/nested/ok.txt")) {
							access._store.set("zzz", {
								kind: "file",
								bytes: Uint8Array.from(Buffer.from("not a directory")),
								mode: 0o644,
								revision: "block",
							});
						}
					},
				},
			),
			/Rolled back all touched files|rollback/i,
		);
		assert.equal(access._store.has("deep/nested/ok.txt"), false);
		assert.equal(access._store.has("deep/nested"), false);
		assert.equal(access._store.has("deep"), false);
		assert.equal(Buffer.from(access._store.get("keep.txt").bytes).toString("utf8"), "keep");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("sandbox apply_patch sanitizes malformed text diagnostics", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-sanitize-"));
	try {
		const invalid = {
			protocolVersion: 2, placement: "sandbox",
			async inspect() { return { kind: "file", bytes: Uint8Array.from([0xff]), mode: 0o644, revision: "bad" }; },
			async writeFile() { throw new Error(`should not write ${cwd}`); },
			async remove() { throw new Error(`should not remove ${cwd}`); },
		};
		await assert.rejects(
			() => applyPatch(patch("*** Update File: bad.txt\n@@\n-a\n+b"), { cwd, workspace: invalid, workspacePlacement: "sandbox" }),
			(error) => /invalid UTF-8/i.test(error.message) && !error.message.includes(cwd),
		);
		const mixed = {
			...invalid,
			async inspect() { return { kind: "file", bytes: Uint8Array.from(Buffer.from("a\r\nb\n")), mode: 0o644, revision: "mixed" }; },
		};
		await assert.rejects(
			() => applyPatch(patch("*** Update File: bad.txt\n@@\n-a\n+b"), { cwd, workspace: mixed, workspacePlacement: "sandbox" }),
			(error) => /mixed LF and CRLF/i.test(error.message) && !error.message.includes(cwd),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("sandbox apply_patch path diagnostics stay workspace-relative", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-v2-relpath-"));
	try {
		const access = createMemoryWorkspaceAccess({ "seed.txt": "alpha\n" });
		const result = await applyPatch(patch("*** Update File: seed.txt\n@@\n-alpha\n+beta"), {
			cwd,
			workspace: access,
			workspacePlacement: "sandbox",
		});
		assert.ok(result.changedFiles.every((p) => !p.startsWith("/") && !p.includes(cwd)));
		assert.equal(result.changedFiles.includes("seed.txt"), true);
		assert.ok(!result.diff.includes(cwd));
		assert.ok(!result.patch.includes(cwd));
		assert.ok(!result.summary.includes(cwd));
		assert.ok(result.files.every((file) => file.absolutePath.startsWith("/workspace/") && !file.absolutePath.includes(cwd)));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
