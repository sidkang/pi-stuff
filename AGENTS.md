# Repository rules

- The whole repository is one Pi package, installed with `pi install git:github.com/sidkang/pi-stuff`. The root `pi` manifest loads `./extensions`, `./skills`, and `./extensions/pi-image-gen/skills`.
- `skills/<name>/SKILL.md`: frontmatter `name` must equal `<name>`.
- `extensions/<name>.ts` for single files; `extensions/<name>/` with `index.ts` or a `package.json` `pi.extensions` entry for directories.
- A directory extension with npm dependencies or tests is a private npm workspace; add it to the root `workspaces` list. Pi runs `npm install --omit=dev` at the root when it installs the package.
- Pi supplies `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`. List them only in `peerDependencies` with `"*"` (and `devDependencies` for tests), never in `dependencies`.
- Root `LICENSE` (MIT) covers original work. An adapted item keeps its upstream license file in its directory and records upstream and local changes in its frontmatter or README.
- Keep tests next to the code; shared test helpers live in `tests/`. `npm test` runs unit suites; `npm run test:e2e` runs suites against the real Pi host found on `PATH`. Host-version lists in the test helpers name the Pi versions each extension is tested with. The codex-tools E2E needs `PI_PACKAGE_DIR` set to the Pi package directory (for Homebrew: `$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent`).
- Before pushing, run `npm test` and gitleaks. Do not push or move bookmarks unless asked.
