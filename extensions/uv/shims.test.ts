import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createMockContext, createMockPi } from "../../tests/extension-harness.mjs";
import uv from "./index.ts";

const shims = join(dirname(fileURLToPath(import.meta.url)), "shims");
const run = (name: string, args: string[]) => spawnSync(join(shims, name), args, { encoding: "utf8" });

describe("shims", () => {
  const blocked: Array<[string, string[], RegExp]> = [
    ["pip", ["install", "x"], /pip is disabled/],
    ["pip3", ["install", "x"], /pip3 is disabled/],
    ["poetry", ["add", "x"], /poetry is disabled/],
    ["python", ["-m", "pip", "list"], /'python -m pip' is disabled/],
    ["python3", ["-mvenv", "x"], /mise py:init/],
    ["python", ["-W", "ignore", "-m", "py_compile", "a.py"], /py_compile/],
  ];
  for (const [name, args, message] of blocked) {
    it(`${name} ${args.join(" ")}`, () => {
      const result = run(name, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
    });
  }

  it("does not treat script arguments as modules", () => {
    const result = run("python", ["/nonexistent/script.py", "pip"]);
    assert.doesNotMatch(result.stderr, /is disabled/);
  });
});

describe("extension", () => {
  it("registers a bash tool that rejects blocked commands at spawn time", async () => {
    const { pi, tools } = createMockPi();
    uv(pi);
    const bash = tools.get("bash");
    assert.ok(bash);
    await assert.rejects(
      bash.execute("id", { command: "pip install x" }, undefined, undefined, createMockContext()),
      /pip is disabled/,
    );
  });
});
