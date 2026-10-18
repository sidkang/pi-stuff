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
    const which = spawnSync("which", ["pi"], { encoding: "utf8" });
    if (which.status === 0) {
      let parent = dirname(realpathSync(which.stdout.trim()));
      for (let i = 0; i < 5; i++, parent = dirname(parent)) {
        candidates.push(parent, join(parent, "libexec/lib/node_modules/@earendil-works/pi-coding-agent"));
      }
    }
  }
  for (const root of candidates) {
    const file = join(root, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent" && ["0.99.1", "0.99.2"].includes(pkg.version)
        && existsSync(join(root, "dist/index.js")) && existsSync(join(root, "dist/index.d.ts"))) return root;
    } catch {}
  }
  throw new Error(`Actual Pi 0.99.1 or 0.99.2 required; set PI_CONTEXT_TEST_HOST to its package directory. Checked: ${candidates.join(", ")}`);
}
