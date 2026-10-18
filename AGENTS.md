# Repository rules

- The whole repository is one Pi package, installed with `pi install git:github.com/sidkang/pi-stuff`. The root `pi` manifest loads `./extensions`, `./skills`, and `./extensions/pi-image-gen/skills`.
- `skills/<name>/SKILL.md`: frontmatter `name` must equal `<name>`.
- `extensions/<name>.ts` for single files; `extensions/<name>/` with `index.ts` or a `package.json` `pi.extensions` entry for directories.
- A directory extension with npm dependencies or tests is a private npm workspace; add it to the root `workspaces` list. Pi runs `npm install --omit=dev` at the root when it installs the package.
- Pi supplies `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`. List them only in `peerDependencies` with `"*"` (and `devDependencies` for tests), never in `dependencies`.
- Root `LICENSE` (MIT) covers original work. An adapted item keeps its upstream license file in its directory and records upstream and local changes in its frontmatter or README.
- Keep tests next to the code. `npm test` runs the suites that work in this layout; apply-patch, codex-tools, and context tests still depend on the old repository's harness.
- Before pushing, run `npm test` and gitleaks. Do not push or move bookmarks unless asked.
