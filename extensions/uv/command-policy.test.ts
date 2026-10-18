import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBlockedCommand } from "./command-policy.ts";

const kind = (command: string) => getBlockedCommand(command)?.kind ?? null;

describe("blocked", () => {
  const cases: Array<[string, string]> = [
    ["pip install x", "pip"],
    ["echo a && pip3 list", "pip3"],
    ["poetry add x", "poetry"],
    ["python -m pip install x", "python-pip"],
    [".venv/bin/python3.12 -mpip list", "python-pip"],
    ["python -W ignore -m venv .venv", "python-venv"],
    ["python -m py_compile a.py", "python-py-compile"],
    ["uv run python -m py_compile a.py", "python-py-compile"],
    ["uv run --with x pip install y", "pip"],
    ["python -m ast a.py b.py", "python-ast-multiple-files"],
  ];
  for (const [command, expected] of cases) {
    it(command, () => assert.equal(kind(command), expected));
  }

  it("points venv users at mise py:init", () => {
    assert.match(getBlockedCommand("python -m venv .venv")?.message ?? "", /mise py:init/);
  });
});

describe("allowed", () => {
  const cases = [
    "uv pip install x",
    "uv run script.py",
    "uv run python -m ast a.py >/dev/null",
    "python foo.py pip",
    "python -c 'print(1)' venv",
    "grep -r 'pip install' .",
    "rg pip README.md",
    "cat > README.md <<'EOF'\n# Install\npip install foo\nEOF",
    'git commit -m "docs\n\npip install x\npython -m venv"',
  ];
  for (const command of cases) {
    it(JSON.stringify(command), () => assert.equal(kind(command), null));
  }
});
