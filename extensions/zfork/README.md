# zfork

A standalone Pi extension that opens a temporary CLI fork of the current saved
session in a horizontal split below the current Kitty pane.

Use `/zfork` to open the fork, or `/zfork <prompt>` to open it and submit an initial prompt.

The child Pi process uses a new session directory under an owner-only temporary
root, so it does not add the fork to the normal project session history. The
extension preserves the current project directory and invokes Pi's native
`--fork <session-file>` behavior. It copies Kitty's source-window environment and
places selected current-process overrides needed by Pi, provider authentication,
proxies, AWS, GitHub, and `PI_*` configuration inside the owner-only launcher
script, rather than exposing secret values in process arguments.

Initial prompts that begin with `-` or `@` are passed as literal text rather than
being interpreted as Pi CLI flags or file arguments.

## Requirements

- Pi must run locally in TUI mode with a saved session. SSH-backed Kitty panes
  are rejected because Kitty would otherwise launch the child on the local host
  with remote paths.
- Kitty remote control must be available through `kitten @` or `kitty @`.
- `KITTY_WINDOW_ID` must identify the current pane.
- The `pi` executable must be discoverable on `PATH`.

The split height defaults to 40%, bounded to 12–32 lines when Kitty reports the
current pane height. Configure it with:

- `PI_ZFORK_HEIGHT_PERCENT`
- `PI_ZFORK_HEIGHT_MIN_LINES`
- `PI_ZFORK_HEIGHT_MAX_LINES`

## Temporary files

Each launch gets a unique owner-only root under the operating system temporary
directory. Its launcher and temporary fork sessions are retained for inspection
and operating-system cleanup.

## Installation

```sh
mise push zfork
```

## Verification

```sh
node --import tsx --test packages/extensions/zfork/zfork.test.ts packages/package-structure.test.mjs
npm test
npm run typecheck
```
