import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("host-runtime PATH discovery handles official npm symlinks and Homebrew wrappers outside local resolution", () => {
	const root = mkdtempSync(join(tmpdir(), "web-access-host-layout-"));
	try {
		// Copy the unchanged helper bytes outside repository module resolution.
		// These dummy packages are discovery-only fixtures: never imported as SDKs,
		// and their executable targets are never executed. Actual SDK E2E is separate.
		const helper = join(root, "isolated", "host-runtime.mjs");
		mkdirSync(join(root, "isolated"));
		writeFileSync(helper, readFileSync(new URL("./host-runtime.mjs", import.meta.url)));
		const script = `import { discoverHost } from ${JSON.stringify(pathToFileURL(helper).href)};
console.log(JSON.stringify({ root: discoverHost().root, version: discoverHost().version }));`;
		for (const version of ["0.99.1", "0.99.2", "1.1.0", "1.3.0"]) {
			for (const layout of ["npm", "homebrew"]) {
				const fixture = join(root, `${layout}-${version}`);
				const bin = join(fixture, "bin");
				const pkg = layout === "npm" ? join(fixture, "global/node_modules/@earendil-works/pi-coding-agent")
					: join(fixture, "keg/libexec/lib/node_modules/@earendil-works/pi-coding-agent");
				mkdirSync(bin, { recursive: true });
				mkdirSync(join(pkg, "dist/bundle"), { recursive: true });
				writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/bundle/cli.js" } }));
				for (const entry of ["dist/index.js", "dist/index.d.ts", "dist/bundle/cli.js"]) writeFileSync(join(pkg, entry), "");
				let executable = join(pkg, "dist/bundle/cli.js");
				if (layout === "homebrew") {
					executable = join(fixture, "keg/bin/pi");
					mkdirSync(join(fixture, "keg/bin"));
					writeFileSync(executable, "");
				}
				symlinkSync(executable, join(bin, "pi"));
				const env = { ...process.env, PATH: bin, NODE_PATH: "" };
				delete env.PI_WEB_ACCESS_HOST;
				const found = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env, encoding: "utf8", timeout: 10_000 });
				assert.equal(found.status, 0, found.error?.message ?? found.stderr);
				assert.deepEqual(JSON.parse(found.stdout), { root: realpathSync(pkg), version }, `${layout} ${version} uses PATH, not a locally resolved SDK`);
				const rejected = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
					env: { ...env, PI_WEB_ACCESS_HOST: join(root, "missing-override") }, encoding: "utf8", timeout: 10_000,
				});
				assert.equal(rejected.status, 1, rejected.error?.message ?? rejected.stderr);
				assert.match(rejected.stderr, /Pi 0\.99\.1, 0\.99\.2, 1\.1\.0, or 1\.3\.0 host not found/);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
