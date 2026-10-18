# Repository rules

- Each `packages/pi-<name>/` is one npm package named `@sidkang/pi-<name>`, published on its own. Folder name and npm name leaf must match.
- Package layout: `package.json` (with `pi` manifest, `files`, `repository.directory`, `publishConfig.access = "public"`), `README.md`, `LICENSE`, and resources in `extensions/` or `skills/<skill-name>/`.
- Pi supplies `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`. List them only in `peerDependencies` with `"*"`, never in `dependencies`.
- Keep tests next to the code they test and exclude them from `files`.
- When adding a package, add it to the README table and make sure the root `pi` manifest covers it.
- Before publishing: `npm test`, `npm pack --dry-run -w packages/<name>`, and install the packed package in a temporary `PI_CODING_AGENT_DIR`.
- Do not publish to npm, push, or move bookmarks unless asked.
