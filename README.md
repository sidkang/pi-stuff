# pi-stuff

Personal [Pi](https://pi.dev) packages. Each directory under `packages/` is an independent npm package.

| Package | Type | Description |
| --- | --- | --- |
| [@sidkang/pi-try-serve](packages/pi-try-serve) | Skill | Share local HTML or a static directory through a temporary Cloudflare tunnel |

## Install

One package:

```sh
pi install npm:@sidkang/pi-try-serve
```

Everything in this repository:

```sh
pi install git:github.com/sidkang/pi-stuff
```

## Develop

```sh
npm install
npm test
pi -e ./packages/<name>   # try one package for one session
```
