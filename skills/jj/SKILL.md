---
name: jj
description: Use Jujutsu in `.jj` repositories. Translate Git requests to JJ-native operations and preserve unrelated current work when creating task changes.
---

# jj

Use `jj` instead of Git whenever `.jj/` exists.

## Mental model

- `@` is the working-copy commit; every JJ command snapshots its current files.
- Change IDs survive rewrites; use them to identify changes. Commit IDs identify one revision.
- Bookmarks publish changes; `jj op log` and `jj undo` recover local operations.

## Safety defaults

- Treat `.jj/` and `.git/` as tool-owned metadata; make repository changes through JJ commands.
- Safe inspection and naming of current `@` need no confirmation: `jj status`, `jj diff`, `jj log`, `jj show`, and `jj describe`.
- Before an operation changes another revision or a parent/child relationship, inspect and request confirmation. This includes `jj new -B` / `--insert-after`, `rebase`, non-scratch `squash`, `absorb`, `split`, `diffedit`, `abandon`, `restore`, bookmark moves/deletes, push, and Gerrit upload.
- An explicit request to squash the current scratch change into its parent authorizes `jj squash` after inspecting `jj status` and `jj diff`.
- Use JJ-native commands; use raw Git only when no JJ equivalent exists and the user explicitly authorizes it.

Before a history mutation, inspect:

```bash
jj status
jj log -n 5
jj diff
```

After it, verify the intended current change and graph:

```bash
jj status
jj log -n 5
```

For conflicts, recovery, workspaces, remotes/Gerrit, divergence, or moving selected content, read [the workflow reference](reference/jj-workflows.md) before choosing commands.

## Starting work

Check whether `@` already contains work:

```bash
jj status
```

- If `@` is empty and this task should use the current commit, describe it without ending it:
  ```bash
  jj describe -m "feat(scope): summarize change"
  ```
- If `@` contains only the requested task, name it with `jj describe`; use `jj commit` only when the user asks to finish it **and** `jj diff` contains only the requested scope.
- If `@` has unrelated work that must remain the latest working copy, inspect the graph and ask before inserting a task change **before** it. After confirmation:
  ```bash
  original=$(jj log -r @ --no-graph -T 'change_id.short()')
  jj new -B @ -m "feat(scope): task summary"
  # edit and verify only this task's files
  jj edit "$original"
  jj status
  jj log -n 5
  ```
  Complete only when the task is the original change's parent, the original change is current `@`, and there are no unexpected conflicts. If task changes were already mixed into the original change, inspect first and ask before using `jj squash --from "$original" --into @ <paths>` to move them.

Leave the task as its named working-copy change unless the user asks to finish it.

## Describe vs commit

- `jj describe -m "..."` updates the description of the current working-copy commit (`@`); it does not move the working copy.
- `jj commit -m "..."` finishes the current `@` and creates a new empty working-copy commit on top.
- `jj describe` is the default for naming current work. Apply the scope check in [Starting work](#starting-work) before `jj commit`.

## Commit messages

Unless project instructions specify otherwise, use Conventional Commits when creating, describing, or suggesting jj commits.

- First line format: `type(scope): summary`.
- Use lowercase `type` and `scope`.
- Include `scope` when the affected area is clear.
- Prefer these types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`.
- Keep the first line concise, but do not force all information into one line.
- When the change set is large or has multiple important parts, use a multi-line message with a blank line after the first line and bullet points in the body.
- For breaking changes, use `!` in the first line and add a body line starting with `BREAKING CHANGE:`.
- Summary and body may be either English or Chinese.

Examples:

```text
feat(zsh): add atuin integration
```

```text
docs(pi): clean plugin workflow docs

- document dotfile-managed install flow
- remove stale direct repo install examples
- shorten repeated plugin README sections
```

## Revsets

Common revsets:

- `@` — the working-copy commit
- `@-` — parent of the working-copy commit
- `::@` — ancestors of `@`
- `@::` — descendants of `@`
- `trunk()..@` — commits between trunk and `@`
- `bookmarks()` — commits with bookmarks

Use revsets with `-r`, for example:

```bash
jj log -r 'trunk()..@'
```

For rebases, prefer `-r` for explicit revisions. Avoid `-s` unless the user wants to move the selected revision and all descendants.

## Snapshot discipline

- Ordinary `jj status`, `jj diff`, `jj log`, and `jj show` may snapshot the current working copy; use them when you want the current file state included.
- Automation that reads already-recorded revisions should use `jj --ignore-working-copy ...` to avoid accidentally changing `@`.
- Before reviewing conversation-boundary anchors or another workspace, run `jj util snapshot` in that workspace explicitly.

## Translate Git intent, don’t mimic Git syntax

- “status” → `jj status`
- “diff” → `jj diff` or `jj show @`
- “name this work” / “amend the message” → `jj describe -m "feat(scope): summary"`
- “commit this” / “finish this change” → inspect `jj diff`; use `jj commit -m "feat(scope): summary"` only when all current changes are in scope
- “amend current content into another change” → ask before `jj squash` or `jj absorb`
- “start work while preserving unrelated current changes” → `jj new -B @ -m "feat(scope): summary"`, then `jj edit <original-change-id>` when done
- “checkout X to start new work” → usually `jj new -m "feat(scope): summary" X`
- “checkout X and keep editing it” → `jj edit X`
- “branch” → `bookmark`
- “fetch/pull latest” → `jj git fetch`, then usually ask before rebasing with `jj rebase -d <destination>`
- “reflog” / “recover” → `jj op log` or `jj undo`

## Useful commands

```bash
jj status
jj log -n 5
jj log -n 10 -r 'trunk()..@'
jj diff
jj show @
jj describe -m "feat(scope): summary"
jj commit -m "feat(scope): summary"
jj new -m "feat(scope): summary" <rev>
jj new -B @ -m "feat(scope): summary"  # insert before current work; inspect and ask first
jj edit <rev>
jj restore <path>  # destructive; ask first
jj squash  # ask first unless user explicitly requested current scratch -> @-
jj absorb  # rewrites history; ask first
jj rebase -d <destination>  # rewrites history; ask first
jj rebase -r <change-id> -d <destination>  # rewrites history; ask first
jj bookmark list
jj bookmark move <name> --to <rev>  # publishing handle; ask first
jj git fetch
jj git push -b <bookmark>  # ask first
jj op log
jj undo
```
