import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findPiHost } from "./pi-host-test-helper.mjs";

const probe = 'const { findPiHost } = await import("./pi-host-test-helper.mjs"); const host = await findPiHost(); console.log(JSON.stringify({ version: host.version, loadedVersion: host.sdk.VERSION, root: host.root }));';

test("host discovery uses a real tested SDK with matching package/runtime versions", async () => {
	const host = await findPiHost();
	assert.ok(["0.99.1", "0.99.2", "1.3.0"].includes(host.version));
	assert.equal(host.sdk.VERSION, host.version);
});

test("explicit host overrides fail closed for empty, missing and unsupported installations", () => {
	const root = mkdtempSync(join(tmpdir(), "apply-patch-host-invalid-"));
	try {
		for (const override of ["", root, join(root, "missing"), new URL("./node_modules/@earendil-works/pi-coding-agent", import.meta.url).pathname]) {
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
				cwd: new URL(".", import.meta.url), env: { ...process.env, PI_APPLY_PATCH_HOST: override }, encoding: "utf8",
			});
			assert.notEqual(result.status, 0, `override must not discover a different SDK: ${override}`);
			assert.match(result.stderr, /PI_APPLY_PATCH_HOST/);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});
