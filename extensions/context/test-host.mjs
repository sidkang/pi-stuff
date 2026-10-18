import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Override is a package directory, not a user profile. Never install test dependencies.
export function findHost() {
  const candidates = [];
  if (process.env.PI_CONTEXT_TEST_HOST !== undefined) {
    if (process.env.PI_CONTEXT_TEST_HOST.trim()) candidates.push(resolve(process.env.PI_CONTEXT_TEST_HOST));
  } else {
    try { candidates.push(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))))); } catch {}
    // Check every pi on PATH: npm scripts put node_modules/.bin (a dev-only SDK) first.
    const which = spawnSync("which", ["-a", "pi"], { encoding: "utf8" });
    for (const binary of which.status === 0 ? which.stdout.split("\n").filter(Boolean) : []) {
      let parent = dirname(realpathSync(binary));
      for (let i = 0; i < 5; i++, parent = dirname(parent)) {
        candidates.push(parent, join(parent, "libexec/lib/node_modules/@earendil-works/pi-coding-agent"));
      }
    }
  }
  for (const root of candidates) {
    const file = join(root, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent" && ["0.99.1", "0.99.2", "1.3.0"].includes(pkg.version)
        && existsSync(join(root, "dist/index.js")) && existsSync(join(root, "dist/index.d.ts"))) return root;
    } catch {}
  }
  throw new Error(`Actual Pi 0.99.1, 0.99.2, or 1.3.0 required; set PI_CONTEXT_TEST_HOST to its package directory. Checked: ${candidates.join(", ")}`);
}
