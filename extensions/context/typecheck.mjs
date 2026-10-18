import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { findHost } from "./test-host.mjs";

const host = findHost();
const unit = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const hostRequire = createRequire(join(host, "package.json"));
const temp = mkdtempSync(join(tmpdir(), "context-typecheck-"));
try {
  const config = join(temp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true,
      strict: true, skipLibCheck: true, types: ["node"],
      typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
      paths: {
        "@earendil-works/pi-coding-agent": [join(host, "dist/index.d.ts")],
        "@earendil-works/pi-tui": [join(dirname(hostRequire.resolve("@earendil-works/pi-tui/package.json")), "dist/index.d.ts")],
      },
    },
    files: [join(unit, "context.ts")],
  }));
  const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--project", config], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
