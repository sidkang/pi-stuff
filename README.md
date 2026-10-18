# pi-stuff

Personal [Pi](https://pi.dev) skills and extensions, installed together as one Pi package:

```sh
pi install git:github.com/sidkang/pi-stuff
pi update --extensions   # after pushing changes
```

Pi installs the npm dependencies of every extension. To turn items off, use the object form of the package in Pi settings, for example `{ "source": "git:github.com/sidkang/pi-stuff", "extensions": ["!extensions/whimsical.ts"] }`, or run `pi config`.

## Contents

- `skills/`: jj, librarian, quark, try-serve, web-browser.
- `extensions/`: single-file extensions (`*.ts`) and directory extensions. Directories with npm dependencies or tests are npm workspaces.

Adapted items keep their upstream license in their directory:

| Item | License | Upstream |
| --- | --- | --- |
| `skills/librarian`, `skills/web-browser` | Apache-2.0 | [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) |
| `skills/quark` | Apache-2.0 | [quark-clouddrive/quarkclouddrive_offical](https://github.com/quark-clouddrive/quarkclouddrive_offical) |
| `extensions/pi-image-gen` | Apache-2.0 | [abhishek944/pi-image-gen](https://github.com/abhishek944/pi-image-gen) |

Everything else is MIT (see [LICENSE](LICENSE)).

## Develop

```sh
npm install
npm test
PI_CODING_AGENT_DIR=~/.config/pi/dev-agent pi -e .   # try local changes in a separate profile
```
