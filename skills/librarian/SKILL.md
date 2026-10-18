---
name: librarian
description: "Cache and refresh remote Git repositories for local source or history inspection. Use when the task requires reading repository files or commit history locally. A repository link in documentation or a question answerable from a web page alone does not require a checkout."
metadata:
  upstream:
    repo: mitsuhiko/agent-stuff
    path: skills/librarian
    commit: 0ad04e3302f30198bf31d4c8b4ba7b5d1d5f6714
    status: modified
    notes:
      - local: limit checkout to tasks requiring local source or history inspection, not every encountered repository link.
---

Use this skill when the task needs local inspection of a remote repository's source or history. Repository references can be GitHub/GitLab/Bitbucket URLs, `git@...`, or `owner/repo` shorthand. For a page-level lookup, read the page instead; a repository link alone is not a reason to clone.

The goal is to keep a reusable local checkout that is:
- **stable** (predictable path)
- **up to date** (periodic fetch + fast-forward when safe)
- **efficient** (partial clone with `--filter=blob:none`, no repeated full clones)

## Cache location

Repositories are stored at:

`~/.cache/checkouts/<host>/<org>/<repo>`

Example:

`github.com/mitsuhiko/minijinja` → `~/.cache/checkouts/github.com/mitsuhiko/minijinja`

## Command

```bash
bash checkout.sh <repo> --path-only
```

Examples:

```bash
bash checkout.sh mitsuhiko/minijinja --path-only
bash checkout.sh github.com/mitsuhiko/minijinja --path-only
bash checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

The script will:
1. Parse the repo reference into host/org/repo.
2. Clone if missing.
3. Reuse existing checkout if present.
4. Fetch from `origin` when stale (default interval: 300s).
5. Attempt a fast-forward merge if the checkout is clean and has an upstream.

## Update strategy

- Default behavior is **throttled refresh** (every 5 minutes) to avoid unnecessary network calls.
- Force immediate refresh with:

```bash
bash checkout.sh <repo> --force-update --path-only
```

## Recommended workflow

1. Resolve repository path via `checkout.sh --path-only`.
2. Use that path for searching, reading, and analysis.
3. On later references to the same repo, call `checkout.sh` again; it will find and update the cached checkout.

## If edits are needed

Prefer not to edit directly in the shared cache. Create a separate worktree or copy from the cached checkout for task-specific modifications.

## Notes

- `owner/repo` defaults to `github.com`.
