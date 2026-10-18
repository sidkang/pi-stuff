import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

// Package-local devDependencies resolve @earendil-works/pi-* and typebox for the
// imported cases. Those cases assert the exact Pi 1.2.0 package-local baseline.
// The host `pi --extension` check below is an additional boot smoke test.
const piBin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
const directLoad = spawnSync(
	piBin,
	[
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--extension",
		resolve("index.ts"),
		"--print",
		"/fast",
	],
	{ encoding: "utf8" },
);

await import("./responses-compaction.cases.mjs");

test("the full plugin loads through host Pi without peer-package symlinks", () => {
	assert.equal(directLoad.status, 0, directLoad.stderr || directLoad.stdout);
});
