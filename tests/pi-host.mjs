import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Tests reach into internal Pi modules that the packages do not export. Search like Node resolves a
// bare import (nearest node_modules first), so workspace-local and hoisted installs both work.
function findPackageDir(name, fromDir) {
	for (let dir = fromDir; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) throw new Error(`${name} not found from ${fromDir}`);
	}
}

export async function importHostModules(testUrl) {
	const codingAgent = findPackageDir("@earendil-works/pi-coding-agent", dirname(fileURLToPath(testUrl)));
	const agentCore = findPackageDir("@earendil-works/pi-agent-core", codingAgent);
	const load = (dir, path) => import(pathToFileURL(join(dir, path)).href);
	const { loadExtensionFromFactory } = await load(codingAgent, "dist/core/extensions/loader.js");
	const { runAgentLoop } = await load(agentCore, "dist/agent-loop.js");
	return { loadExtensionFromFactory, runAgentLoop };
}
