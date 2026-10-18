import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testedVersions = ["0.99.2", "0.99.1"];

/** Resolve a real, unpacked Pi SDK; an explicit override never falls back. */
export async function findPiHost() {
	const explicit = process.env.PI_APPLY_PATCH_HOST !== undefined;
	const candidates = [];
	if (explicit) {
		if (!process.env.PI_APPLY_PATCH_HOST.trim()) throw new Error("PI_APPLY_PATCH_HOST must name an unpacked Pi SDK directory.");
		candidates.push(resolve(process.env.PI_APPLY_PATCH_HOST));
	} else {
		// Discover the current CLI first, including Homebrew's shell-wrapper layout.
		for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
			const executable = join(dir, "pi");
			if (!existsSync(executable)) continue;
			let current = dirname(realpathSync(executable));
			for (let depth = 0; depth < 6; depth++) {
				candidates.push(current, join(current, "lib/node_modules/@earendil-works/pi-coding-agent"), join(current, "libexec/lib/node_modules/@earendil-works/pi-coding-agent"));
				current = dirname(current);
			}
		}
		try {
			const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
			candidates.push(dirname(dirname(entry)));
		} catch {}
		try { candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent")); } catch {}
	}
	const hosts = [];
	for (const root of new Set(candidates)) {
		let pkg;
		try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch { continue; }
		if (pkg.name === "@earendil-works/pi-coding-agent" && testedVersions.includes(pkg.version)) {
			if (!existsSync(join(root, "dist/index.js"))) throw new Error(`Pi SDK entry point is missing: ${root}`);
			hosts.push({ root: realpathSync(root), version: pkg.version });
		}
	}
	// Prefer the current tested release for normal root gates, even if a local
	// installation of the original regression release is also discoverable.
	hosts.sort((a, b) => testedVersions.indexOf(a.version) - testedVersions.indexOf(b.version));
	const host = hosts[0];
	if (!host) throw new Error(`A real Pi 0.99.1 or 0.99.2 SDK is required${explicit ? ` at PI_APPLY_PATCH_HOST=${process.env.PI_APPLY_PATCH_HOST}` : "; set PI_APPLY_PATCH_HOST to its unpacked package directory"}. No skip or mocked/older-host fallback is allowed.`);
	const sdk = await import(pathToFileURL(join(host.root, "dist/index.js")).href);
	if (sdk.VERSION !== host.version) throw new Error(`Pi package/runtime version mismatch: package ${host.version}, loaded SDK ${sdk.VERSION} (${host.root})`);
	return { ...host, sdk };
}
