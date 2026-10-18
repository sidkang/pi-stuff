import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { discoverHost, hostDependency } from "./host-runtime.mjs";

const unit = dirname(fileURLToPath(import.meta.url));
const host = discoverHost();
const require = createRequire(import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "web-access-typecheck-"));
try {
	const config = JSON.parse(require("node:fs").readFileSync(join(unit, "tsconfig.json"), "utf8"));
	config.compilerOptions.paths = Object.fromEntries(["pi-ai", "pi-coding-agent", "pi-tui"].map((name) => {
		const root = name === "pi-coding-agent" ? host.root : hostDependency(host, `@earendil-works/${name}`);
		return [`@earendil-works/${name}`, [join(root, "dist/index.d.ts")]];
	}));
	config.compilerOptions.typeRoots = [join(unit, "node_modules/@types")];
	config.include = [join(unit, "**/*.ts")];
	config.exclude = [join(unit, "node_modules")];
	writeFileSync(join(temp, "tsconfig.json"), JSON.stringify(config));
	console.log(`Checking declarations against Pi ${host.version}: ${host.root}`);
	const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(temp, "tsconfig.json"), "--noEmit"], { stdio: "inherit" });
	process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
