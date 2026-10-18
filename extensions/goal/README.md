---
metadata:
  upstream:
    repo: mitsuhiko/agent-stuff
    path: extensions/goal.ts
    commit: 0865c849befd2021490679f96a8dee58c84ac857
    status: copied-verbatim
---

# Goal

Mitsuhiko's session-log-backed long-running goal extension. `goal.ts` is copied
verbatim from the recorded upstream commit. The local package manifest and this
README wrap that single extension; `LICENSE` is the upstream Apache-2.0 license.

## Install

From this repository:

```sh
mise push goal
```

Reload Pi with `/reload` after installation, or start a new session.

## Commands

- `/goal <objective>` — start pursuing a goal.
- `/goal` — show the current objective, status, and usage.
- `/goal pause` — pause automatic continuation.
- `/goal resume` — resume the goal.
- `/goal edit` — edit the objective in the interactive editor.
- `/goal clear` — remove the goal.

Model tools: `get_goal`, `create_goal`, and `update_goal`. An optional positive
integer token budget is set through `create_goal`, not a slash-command flag.
Goals started through `/goal <objective>` have no token budget by default.

State follows the current session branch. Completion verification and the
three-turn blocker audit are model instructions, not an independent auditor.
Do not enable another extension that registers the same command or tools.
