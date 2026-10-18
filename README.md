# pi-stuff

Personal [Pi](https://pi.dev) skills and extensions.

## Skills

| Skill | Description | License |
| --- | --- | --- |
| [jj](skills/jj) | Use Jujutsu (jj) and translate Git requests to jj-native operations | MIT |
| [librarian](skills/librarian) | Cache remote Git repositories for local source and history inspection | Apache-2.0, adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) |
| [quark](skills/quark) | Operate Quark Drive (夸克网盘) with reversible deletion and resumable uploads | Apache-2.0, adapted from [quark-clouddrive/quarkclouddrive_offical](https://github.com/quark-clouddrive/quarkclouddrive_offical) |
| [try-serve](skills/try-serve) | Share local HTML or a static directory through a temporary Cloudflare tunnel | MIT |
| [web-browser](skills/web-browser) | Drive Chrome or Chromium through the Chrome DevTools Protocol | Apache-2.0, adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) |

Install one skill globally (Pi reads `~/.agents/skills/`):

```sh
npx skills add sidkang/pi-stuff --skill jj -g -a pi
npx skills update -g
```

Adapted skills record their upstream commit or version and local changes in the `SKILL.md` frontmatter.

## Packages

Extensions with npm dependencies, published to npm.

| Package | Description |
| --- | --- |
| [@sidkang/pi-web-access](packages/pi-web-access) | `web_search`, `x_search`, and `fetch_content` tools |

```sh
pi install npm:@sidkang/pi-web-access
```

## Develop

```sh
npm install
npm test
npx skills add . --list
```
