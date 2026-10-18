# Repository rules

- The directory decides how an item is installed; each item uses exactly one way:
  - `skills/<name>/`: installed with `npx skills add sidkang/pi-stuff --skill <name>`. The frontmatter `name` must equal `<name>`.
  - `packages/pi-<name>/`: extensions with npm dependencies, published to npm as `@sidkang/pi-<name>`.
- Root `LICENSE` (MIT) covers original work. An adapted item keeps its upstream license file inside its directory and records upstream and local changes in its frontmatter or README.
- Extensions without npm dependencies (importing only `node:` modules and the Pi-supplied packages below) do not belong here; they live in the dotfiles repository under `pi/agent/extensions/`.
- Pi supplies `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`. In packages, list them only in `peerDependencies` with `"*"`.
- Keep tests next to the code they test. `npm test` runs them.
- When adding an item, add it to the README.
- Before pushing, run `npm test` and gitleaks. Do not publish to npm, push, or move bookmarks unless asked.
