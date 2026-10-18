import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";

/** Tests and declaration checks use the real supported host, never a mocked runtime. */
export function discoverHost() {
	const require = createRequire(import.meta.url);
	const candidates = [];
	if (process.env.PI_WEB_ACCESS_HOST !== undefined) {
		if (process.env.PI_WEB_ACCESS_HOST.trim()) candidates.push(resolve(process.env.PI_WEB_ACCESS_HOST));
	} else {
		for (const directory of require.resolve.paths("@earendil-works/pi-coding-agent") ?? []) candidates.push(join(directory, "@earendil-works/pi-coding-agent"));
		for (const entry of (process.env.PATH ?? "").split(delimiter)) {
			const binary = join(entry, "pi");
			if (!existsSync(binary)) continue;
			let location = dirname(realpathSync(binary));
			for (let i = 0; i < 5; i++, location = dirname(location)) {
				candidates.push(location, join(location, "libexec/lib/node_modules/@earendil-works/pi-coding-agent"));
			}
		}
	}
	for (const root of candidates) {
		try {
			const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
			if (pkg.name === "@earendil-works/pi-coding-agent" && ["0.99.1", "0.99.2", "1.1.0", "1.3.0"].includes(pkg.version)
				&& existsSync(join(root, "dist/index.js")) && existsSync(join(root, "dist/index.d.ts"))) return { root, version: pkg.version, require: createRequire(join(root, "package.json")) };
		} catch {}
	}
	throw new Error("Pi 0.99.1, 0.99.2, 1.1.0, or 1.3.0 host not found. Set PI_WEB_ACCESS_HOST to its @earendil-works/pi-coding-agent package directory.");
}

export function hostDependency(host, name) {
	for (const directory of host.require.resolve.paths(name) ?? []) {
		const root = join(directory, name);
		if (existsSync(join(root, "package.json"))) return root;
	}
	throw new Error(`Host dependency not found: ${name}`);
}
