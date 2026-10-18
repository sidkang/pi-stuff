---
metadata:
  upstream:
    repo: mitsuhiko/agent-stuff
    path: extensions/uv.ts, intercepted-commands
    commit: 0865c849befd2021490679f96a8dee58c84ac857
    status: modified
    notes:
      - local: replace the spawn-time regexes with a tokenizing command policy (`command-policy.ts`) that ignores heredoc bodies, quoted text, and non-command arguments.
      - local: also block `uv run pip|poetry|python -m pip|venv|py_compile` and multi-file `python -m ast`.
      - local: register `createBashToolDefinition` so the bash tool keeps the per-call `ctx.cwd`.
      - local: `shims/` merges `python`/`python3` and `pip`/`pip3`, only inspects the `-m` module, and prefers the mise `UV_PYTHON` interpreter.
      - local: `python -m venv` points to `mise py:init` / `mise py:reset`.
---

# uv

Replaces the `bash` tool so Python tooling goes through `uv`:

- `pip`, `pip3`, `poetry`, `python -m pip|venv|py_compile` are rejected, both by the spawn-time policy and by the PATH shims in `shims/`.
- `python` / `python3` run as `uv run python`.

The paired skill is [`skills/uv`](../../skills/uv). Guardrails do not apply inside `ssh` or containers.
