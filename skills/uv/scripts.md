# Running Scripts with uv

## Basic Usage

```bash
uv run script.py                   # Run a script
uv run script.py arg1 arg2         # With arguments
uv run --python 3.10 script.py     # Specific Python version
echo 'print("hi")' | uv run -      # From stdin
```

In a project directory, use `--no-project` to skip installing the project:

```bash
uv run --no-project script.py
```

## Project Venvs on This Machine

Use the centralized mise-managed venv flow instead of creating `.venv` by hand:

```bash
mise py:init [venv-name]
mise py:reset [venv-name]
```

`mise py:init` writes or updates `mise.toml` so project tools use a central venv:

```toml
VIRTUAL_ENV = "{{ env.CENTRAL_VENV_DIR }}/{{ env.VENV_NAME }}"
UV_PROJECT_ENVIRONMENT = "{{ env.VIRTUAL_ENV }}"
UV_PYTHON = "{{ env.VIRTUAL_ENV }}/bin/python"
_.python.venv = { python = '3.13', create = true, path = '{{ env.VIRTUAL_ENV }}', uv_create_args = ['--seed'] }
```

If a name is passed, it is stored in `.venv-name`; otherwise the project directory basename is used. `mise py:reset` removes only venvs under `CENTRAL_VENV_DIR` and recreates them via mise.

For one-off heredoc scripts, prefer `uv run python` when dependencies or interpreter selection matter:

```bash
uv run python - <<'PY'
print("hello")
PY
```

## Syntax Verification (No `__pycache__`)

Use the AST parser instead of `python -m py_compile` for syntax-only checks:

```bash
uv run python -m ast script.py >/dev/null
```

`python -m ast` accepts one input file. For multiple files, loop explicitly:

```bash
for f in src/app.py tests/test_app.py; do
  uv run python -m ast "$f" >/dev/null || exit 1
done
```

With `find`:

```bash
find src tests -name '*.py' -print0 |
  xargs -0 -n1 uv run python -m ast >/dev/null
```

Do not use `py_compile` for syntax-only checks because it writes bytecode:

```bash
python -m py_compile file.py
uv run python -m py_compile file.py
```

Avoid `compileall` for syntax-only checks unless bytecode output is intentional.

## Ad-hoc Dependencies

```bash
uv run --with requests script.py
uv run --with 'requests>2,<3' script.py
uv run --with requests --with rich script.py
uv run --with polars python - <<'PY'
import polars as pl
PY
```

## Ad-hoc Tools

If the tool is not a project dependency yet, use `--with`:

```bash
uv run --with pytest pytest -q
uv run --with ruff ruff check .
```

If the tool belongs to the project, add it:

```bash
uv add --dev pytest ruff
uv run pytest -q
uv run ruff check .
```

## Inline Script Metadata (Recommended)

Declare dependencies directly in the script:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///

import requests
from rich import print
```

Then just:

```bash
uv run script.py
```

### Managing Dependencies

```bash
uv init --script example.py --python 3.12   # Create script with metadata
uv add --script example.py requests rich    # Add dependencies
```

### Alternative Index

```bash
uv add --index "https://example.com/simple" --script example.py requests
```

Adds to metadata:

```python
# [[tool.uv.index]]
# url = "https://example.com/simple"
```

## Locking Dependencies

```bash
uv lock --script example.py  # Creates example.py.lock
```

## Reproducibility

Pin resolution date:

```python
# /// script
# dependencies = ["requests"]
# [tool.uv]
# exclude-newer = "2023-10-16T00:00:00Z"
# ///
```

## Executable Scripts (Shebang)

```python
#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["httpx"]
# ///

import httpx
print(httpx.get("https://example.com"))
```

```bash
chmod +x myscript
./myscript
```

## Remote and Container Commands

Local Pi command shims do not affect commands executed inside `ssh`, Docker, or containers. If the remote/container has `uv`, call it explicitly there. If it does not, use the environment's existing interpreter intentionally.
