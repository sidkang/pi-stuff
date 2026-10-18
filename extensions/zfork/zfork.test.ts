import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { createMockPi } from "../../../tests/extension-harness.mjs";
import zfork, { __test } from "./zfork.ts";

const ENV_KEYS = [
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_ZFORK_HEIGHT_PERCENT",
  "PI_ZFORK_HEIGHT_MIN_LINES",
  "PI_ZFORK_HEIGHT_MAX_LINES",
  "KITTY_WINDOW_ID",
  "OPENAI_API_KEY",
] as const;

function withEnvironment(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => void): void {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("zfork", () => {
  it("shell-quotes values and makes flag-like prompts literal messages", () => {
    withEnvironment({ OPENAI_API_KEY: "sec'ret" }, () => {
      const script = __test.buildZforkScript(
        "/tmp/pi custom",
        "/tmp/session's file.jsonl",
        "/private/tmp/zfork root",
        "  --print  ",
      );

      assert.match(script, /(?:^|\n)export OPENAI_API_KEY='sec'\\''ret'(?:\n|$)/);
      assert.match(script, /'\/tmp\/pi custom' --session-dir "\$session_dir" --fork '\/tmp\/session'\\''s file\.jsonl'/);
      assert.match(script, /' --print'/);
      assert.match(script, /mktemp -d '\/private\/tmp\/zfork root\/session\.XXXXXXXX'/);
      assert.equal(__test.normalizeInitialPrompt("@secret.txt"), " @secret.txt");
      assert.equal(__test.normalizeInitialPrompt("normal prompt"), "normal prompt");
      assert.equal(__test.normalizeInitialPrompt("   "), null);
    });
  });

  it("uses bounded height settings and identifies the current Kitty window", () => {
    withEnvironment(
      {
        PI_ZFORK_HEIGHT_PERCENT: "120",
        PI_ZFORK_HEIGHT_MIN_LINES: "20.9",
        PI_ZFORK_HEIGHT_MAX_LINES: "10",
        KITTY_WINDOW_ID: "42",
      },
      () => {
        assert.deepEqual(__test.getHeightSettings(), { minLines: 20, maxLines: 20, percent: 99 });
        assert.deepEqual(
          __test.findSelfWindow([{ tabs: [{ id: 9, windows: [{ id: 1 }, { id: 42, lines: 50 }] }] }]),
          { tabId: 9, window: { id: 42, lines: 50 } },
        );
      },
    );
  });

  it("targets the current Kitty window and forwards selected runtime environment", () => {
    const args = __test.buildKittyLaunchArgs(9, "42", "/repo", "/tmp/script.sh", 40);
    assert.deepEqual(args.slice(0, 12), [
      "@", "launch", "--match", "id:9", "--type", "window",
      "--location", "hsplit", "--next-to", "id:42", "--source-window", "id:42",
    ]);
    assert.ok(args.includes("--copy-env"));
    assert.ok(args.includes("/bin/bash"));
    assert.equal(args.at(-1), "/tmp/script.sh");

    assert.deepEqual(__test.buildForwardedEnvironmentLines({
      PATH: "/bin",
      OPENAI_API_KEY: "sec'ret",
      PI_CODING_AGENT_DIR: "/agent",
      UNRELATED: "drop",
    }), [
      "export OPENAI_API_KEY='sec'\\''ret'",
      "export PATH='/bin'",
      "export PI_CODING_AGENT_DIR='/agent'",
    ]);
    assert.equal(args.includes("OPENAI_API_KEY=secret"), false);
  });

  it("creates each launcher beneath a unique owner-only temporary root", () => {
    const first = __test.writeZforkScript((root) => `printf '%s' ${__test.shellEscape(root)}`);
    const second = __test.writeZforkScript("exit 0");
    try {
      assert.notEqual(first.root, second.root);
      assert.equal(statSync(first.root).mode & 0o777, 0o700);
      assert.equal(statSync(first.scriptPath).mode & 0o777, 0o700);
      assert.match(readFileSync(first.scriptPath, "utf8"), new RegExp(first.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  it("bounds and removes controls from launch errors", () => {
    const message = __test.describeError({ stderr: `bad\u001b]0;title\u0007\n${"x".repeat(1000)}` });
    assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(message), false);
    assert.ok([...message].length <= 500);
  });

  it("registers the slash command", () => {
    const harness = createMockPi();
    zfork(harness.pi);

    assert.equal(harness.commands.get("zfork")?.description.includes("temporary fork"), true);
  });
});
