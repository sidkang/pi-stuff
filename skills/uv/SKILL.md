---
name: uv
description: Use `uv` instead of pip/python/venv for Python scripts and lightweight project dependency management.
compatibility: Pi skill for environments with `uv` and Sid's mise Python tasks.
metadata:
  upstream:
    repo: mitsuhiko/agent-stuff
    path: skills/uv
    commit: 0865c849befd2021490679f96a8dee58c84ac857
    status: modified
    notes:
      - local: narrow to `uv run`, inline script metadata, `uv add`; drop `uv_build` / publishing guidance (build.md).
      - local: centralized project venvs via `mise py:init` / `mise py:reset`; multi-file `python -m ast` loop and ssh/container notes.
---

<!-- Upstream reference: https://github.com/mitsuhiko/agent-stuff/tree/main/skills/uv -->

# uv

Use `uv` for Python scripts and lightweight projects. Project venvs on this machine are centralized and managed by mise.

## Rules

- Project venv setup: `mise py:init [venv-name]`.
- Recreate project venv: `mise py:reset [venv-name]`.
- Do not create local `.venv` with `python -m venv`.
- Run project commands with `uv run ...`.
- Add deps with `uv add <package>`; dev tools with `uv add --dev <tool>`.
- Use `uv run --with PACKAGE ...` for one-off deps/tools.
- Prefer inline script metadata for standalone scripts.
- Syntax-only check: `uv run python -m ast file.py >/dev/null`.
- Check multiple files one at a time.
- Local guardrails do not apply inside `ssh`, Docker, or containers.

## Common commands

```bash
mise py:init [venv-name]
mise py:reset [venv-name]
uv run script.py
uv run python - <<'PY'
print("quick script")
PY
uv run --with requests python script.py
uv run --with pytest pytest -q
uv add requests
uv add --dev pytest ruff
uv run python -m ast foo.py >/dev/null
```

## Central venv

`mise py:init [venv-name]` updates `mise.toml` so uv uses `CENTRAL_VENV_DIR/<name>` through `VIRTUAL_ENV`, `UV_PROJECT_ENVIRONMENT`, `UV_PYTHON`, and `_.python.venv`.

If `[venv-name]` is omitted, the project directory basename is used. Passing a name writes `.venv-name`.

## Syntax checks

Avoid `python -m py_compile` for syntax-only checks because it writes `__pycache__`.

```bash
for f in file1.py file2.py; do
  uv run python -m ast "$f" >/dev/null || exit 1
done
```

## More details

See [scripts.md](scripts.md). Do not introduce `uv_build` or package publishing setup unless asked.
