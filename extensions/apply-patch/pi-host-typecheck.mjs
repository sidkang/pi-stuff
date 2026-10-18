import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findPiHost } from "./pi-host-test-helper.mjs";

const host = await findPiHost();
console.log(`Typechecking against actual Pi ${host.version}: ${host.root}`);
const unit = dirname(fileURLToPath(import.meta.url));
const requireHost = createRequire(join(host.root, "package.json"));
const paths = { "@earendil-works/pi-coding-agent": [join(host.root, "dist/index.d.ts")] };
for (const [name, declaration] of [["@earendil-works/pi-ai", "dist/compat.d.ts"], ["@earendil-works/pi-tui", "dist/index.d.ts"], ["typebox", "build/index.d.mts"]]) {
	const candidates = requireHost.resolve.paths(name).map((dir) => join(dir, name, declaration));
	const path = candidates.find(existsSync);
	if (!path) throw new Error(`Cannot find the actual host declaration for ${name}: ${declaration}`);
	paths[name] = [path];
}
const configPath = join(unit, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, unit, { paths }, configPath);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
	console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCurrentDirectory: () => unit,
		getCanonicalFileName: (path) => path,
		getNewLine: () => "\n",
	}));
	process.exitCode = 1;
}
