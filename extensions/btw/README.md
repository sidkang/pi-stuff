---
metadata:
  upstream:
    repo: mitsuhiko/agent-stuff
    path: extensions/btw.ts
    commit: 0865c849befd2021490679f96a8dee58c84ac857
    status: modified
    notes:
      - local: package the unchanged upstream btw.ts as a standalone delivery unit with a local package.json, README, and upstream Apache-2.0 LICENSE.
---

# btw

A branch-aware side-chat popover from
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/btw.ts).
The TypeScript implementation is copied without changes.

## Install

Run `mise push btw` from the repository root, then `/reload` in Pi.
The installer copies this unit to `<PI_CODING_AGENT_DIR>/extensions/btw/`.
No npm runtime dependencies are required; Pi supplies its host modules.
Do not enable another extension registering `/btw` at the same time.

## Use

- `/btw <question>` opens the popover and asks immediately.
- `/btw` opens a new side chat or offers to continue/reset the existing one.
- Enter sends a question. Escape closes the popover; it does not abort an active request.
- Closing a completed thread offers to keep it or inject a generated summary
  into the main conversation. Injection sends a user message immediately, or
  queues a follow-up when the main agent is busy, and resets the side thread.

The side agent uses the main model and thinking level, seeded from the current
main branch and saved side questions. Completed question/answer pairs are stored
as hidden custom session entries. Session startup and tree navigation restore
those on the current branch after its latest side-thread reset. These entries
are not separate native conversation branches and do not enter the main model's
context unless a summary is injected.

## Boundaries

- The child exposes local `read`, `bash`, `edit`, and `write` tools by default.
  It is **not read-only** and does not inherit the parent's extension hooks,
  custom execution backends, or extension tools. There is no file-overlap guard.
- The popover renders Markdown and live tool status, but has no history-scroll,
  transcript-search, or split-pane controls. Only the tail of recent messages is visible.
- The input is single-line; additional questions are rejected while a response is running.
- Saved question/answer text is restored, not the child's full tool transcript.

## License

Upstream code is Apache-2.0; see [LICENSE](LICENSE).
