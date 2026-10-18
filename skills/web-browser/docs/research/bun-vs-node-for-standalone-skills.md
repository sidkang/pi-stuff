# Bun vs. Node for dependency-free standalone Pi skill scripts

**Research date:** 2026-07-25  
**Scope:** Whether this repository should prefer Bun built-ins over npm dependencies, with `packages/skills/web-browser` as the concrete case. This report uses official Bun and Node documentation, the official `ws` repository, and the repository’s checked-out source.

## Executive conclusion

> **Superseded 2026-08-13:** `packages/skills/web-browser` now uses **Bun 1.3+** because authenticated CloakBrowser Manager CDP connections require an `Authorization` header during the WebSocket handshake. Bun's client WebSocket supports custom headers without an npm dependency; Node's built-in WebSocket does not. The comparison below records the earlier Node-first decision and the evidence that led to it before this new requirement was demonstrated.

The durable repository rule is:

> Prefer a stable built-in API of the skill's declared runtime over an npm package when it covers the exact use. Choose Node or Bun according to upstream alignment, audience, and operational needs rather than adopting one universal runtime.

For this skill, the global browser-style `WebSocket` API is sufficient: `cdp.js` creates a client socket, uses `addEventListener("open" | "error" | "message")`, sends JSON strings, and closes it. It does not use `ws`'s server, stream, handshake, ping/pong, or compression-specific APIs. Node added global WebSocket in v20.10.0/v21.0.0, removed the CLI flag in v22.0.0, and marked it stable in v22.4.0. Therefore Node.js 22.4+ removes the `ws` dependency without introducing a second runtime solely for WebSocket support.

## Concrete inspection: `packages/skills/web-browser`

### Runtime shape and dependencies

* `SKILL.md` declares `compatibility: Node.js 22.4+; Chrome or Chromium with remote debugging enabled`. The executable command scripts use `#!/usr/bin/env node`.
* `scripts/cdp.js` has no package import. It relies on Node's Web-compatible globals: `fetch`, `AbortController`, stable `WebSocket`, `ArrayBuffer`, `TextDecoder`, and `Buffer`. Its CDP protocol work is conventional request/response JSON over one client socket.
* Other scripts import Node-compatibility specifiers: `node:fs`, `node:os`, `node:path`, `node:url`, and `node:child_process`. `watch.js` uses the `node:fs` writable stream API. `start.js` uses `spawn` and `execSync`, detaches Chrome, and then runs the watcher as `spawn(process.execPath, [watcherPath], { detached: true, stdio: "ignore" }).unref()`.
* The repository test explicitly asserts that the skill has no `scripts/package.json` or `scripts/package-lock.json`, that CDP does not import `ws`, and that executable scripts use the Node shebang.
* There is nevertheless a currently checked-out `scripts/node_modules/ws` (including a hidden `.package-lock.json`) at the time of research. It is not imported by current source and is contrary to the intended dependency-free state; its presence should be treated as stale generated/vendor material, not as evidence that the running skill needs it. This report does **not** remove it.

### Exact Bun compatibility assessment

Bun was evaluated as a viable alternative but is not the selected runtime for this skill. The comparison remains relevant for future Bun-targeted skills.

| Used capability | Evidence / status in Bun documentation | Consequence for a Bun-targeted variant |
|---|---|---|
| `node:fs` (including sync operations, `watch`, `createWriteStream`) | Bun labels it fully implemented but says 92% of Node’s test suite passes. | A reasonable fit, but `watch`/stream behavior merits the existing end-to-end checks rather than an assumption of bit-for-bit Node equivalence. |
| `node:os`, `node:path`, `node:url` | Bun labels each fully implemented; os/path/url report 100% of Node test suite passing. | Low compatibility risk for `homedir`, temp directory, joins, `dirname`, and `fileURLToPath`. |
| `node:buffer` / global `Buffer` | `node:buffer` is labelled fully implemented. | `Buffer.from(base64)` for CDP screenshots is within the straightforward supported surface. |
| `node:stream` | Labelled fully implemented. | The file-write stream in `watch.js` has documented module coverage. |
| `fetch`, `AbortController`, `WebSocket`, encoding/event globals | Bun’s Web API table lists all of these, including `WebSocket`, `TextDecoder`, `EventTarget`, `ErrorEvent`, and `MessageEvent`. | This is precisely the browser-style event API used in `cdp.js`; no `ws` API adaptation is needed. |
| `node:child_process` `spawn` / `execSync` | Bun labels it partial: missing `proc.gid`/`proc.uid`, no exported `Stream` class, no socket-handle IPC, and Node↔Bun IPC only with JSON serialization. | The documented gaps do not match this skill’s simple spawn/exec, detached process, ignored stdio, and no IPC/socket-handoff use. Still, process lifecycle is the highest runtime-specific risk and should be integration-tested on supported OSes. |
| `process`, including `execPath` | Bun calls `process` “mostly implemented,” noting partial `process.binding`, no-op title on macOS/Linux, stubs, and some newer absent APIs. | `process.execPath` is a conventional runtime path used to launch the watcher. The skill should retain an integration test that confirms the detached watcher starts under each supported Bun version; it should not infer full Node-process parity from this one successful use. |

Bun’s compatibility page is useful but is not a blanket guarantee: it says its status is updated regularly and reflects Node v23, identifies partial modules explicitly, and makes a broad project claim that Node-package incompatibilities are bugs. For operational decisions, the partial `child_process`, `process`, and non-100%-test-suite `fs` qualifications matter more than the headline.

## WebSocket API, stability, and whether `ws` remains necessary

### Bun

Bun documents `WebSocket` among its supported Web-standard APIs. This is the right *client* surface for the code here: WebSocket-compatible `EventTarget` events and `send`/`close`. Bun’s dedicated WebSocket guide is mostly about a different product surface—Bun server sockets via `Bun.serve()`—and explicitly distinguishes its server handler object from the client-side `WebSocket` class that extends `EventTarget`.

That distinction is consequential: do not replace `ws` mechanically when a skill needs a Node-style server, `createWebSocketStream`, server upgrade control, or `ws`-specific operational options. Those requirements should be evaluated against `Bun.serve()` or retained as an explicit dependency/runtime design, rather than assuming global client WebSocket is API-compatible with `ws`.

Bun’s server guide publishes a benchmark (~700k vs ~100k messages/s for a dated Linux x64 chat-room comparison: Bun v0.2.1 versus Node v18.10.0 plus `ws`). This is first-party evidence only for that server benchmark. It is **not evidence** that this one-client CDP command will be observably faster, and should not drive the choice here.

### Node

Node’s official versioned documentation gives a clear migration boundary:

* **v20.10.0 and v21.0.0:** global browser-compatible `WebSocket` added.
* **Node 20:** experimental and must be enabled with `--experimental-websocket`.
* **v22.0.0:** no longer behind that flag.
* **v22.4.0:** no longer experimental; Stability 2 (stable).

Accordingly:

* `ws` is **not necessary for a WebSocket client** in Bun or Node >=22.4 when the browser-compatible interface is sufficient.
* For a Node 20 target, either raise the runtime floor, deliberately pass an experimental flag, or retain a dependency/alternate implementation. Do not claim it is a no-prerequisite built-in.
* For server-specific or `ws`-specific features, `ws` can remain necessary even on modern Node: Node’s global is a client-oriented browser-compatible API, while `ws` provides a `WebSocketServer` and Node-specific APIs.

The official `ws` project still describes itself as a client-and-server library for Node, documents `npm install ws`, supports Node >=10, and offers optional native `bufferutil` acceleration. Its documentation also states that browser clients must use the native WebSocket object. This supports removing it from this client-only skill; it does not establish that `ws` is obsolete for every Node application.

## Portability and prerequisite costs

### Bun-first costs and benefits

**Benefits**

* One installed Bun executable supplies execution, package management (if ever needed), global fetch/WebSocket, and the Node-compatible modules used here. Bun’s installation documentation says it ships as a single dependency-free executable and supports macOS, Linux, and Windows.
* For a no-import skill, there is no per-skill install step, registry availability requirement, `node_modules`, transitive dependency graph, lifecycle-script surface, or lockfile to maintain.
* For a skill already overtly Bun-targeted in metadata and shebangs, choosing Bun does not introduce a hidden runtime contract.

**Costs**

* Bun is an additional runtime prerequisite for users who otherwise have Node. It must be installed and placed on `PATH`; `#!/usr/bin/env bun` depends on Unix-like `env`/PATH lookup. Direct execution of that shebang is not a portable Windows launch convention, even though Bun itself supports Windows.
* A bare `Bun 1.1+` range is broad for a skill relying on runtime compatibility. It makes exact reproduction less deterministic than pinning or testing a narrower version range. Bun’s current compatibility page itself identifies incomplete surfaces, especially process and child process.
* `start.js` is independently platform-specific: it hard-codes macOS application locations, macOS Chrome-profile layout, and invokes `rsync`. Therefore moving this particular skill to Node would not by itself make it cross-platform. Conversely, do not generalize its acceptable Bun cost to skills that otherwise run everywhere.
* In a Bun-targeted variant, `process.execPath` launches the Bun executable. Passing `watcherPath` as its argument is the intended self-reexec model, but it remains a runtime coupling that should be integration-tested after Bun upgrades.

### Node-first costs and benefits

**Benefits**

* Node is often the preinstalled/project-standard JavaScript runtime and is the better interoperability choice where a Pi skill must work in Node-based environments. Node >=22.4 now provides stable global WebSocket, avoiding `ws` for this exact client shape.
* Node’s own `node:child_process` and `process` APIs are the native runtime contract, avoiding Bun compatibility variance for skills heavily dependent on streams, IPC, native addons, process handles, or Node test-runner semantics.

**Costs**

* A Node floor below 22.4 cannot honestly use global WebSocket as a stable default. Node 20 needs an experimental flag, while older Node needs `ws` or another implementation.
* Retaining `ws` means a manifest and committed lockfile should pin the resolution. The lockfile materially improves reproducibility of an installation, but it does not eliminate dependency maintenance, audit/upgrade work, registry/tarball availability, or supply-chain exposure. `ws` can additionally discover optional performance packages; its docs specifically call out an optional native `bufferutil` module and a Node module-resolution security consideration.

## Security, lockfiles, and reproducibility

A dependency-free script is not magically secure—Bun/Node, Chrome, the operating system, and the repository source remain trusted components—but it does reduce this skill’s application-level supply-chain and install surface:

* It removes the direct `ws` tarball and any optional/native package choices from this skill’s runtime closure.
* It removes installation lifecycle and registry-resolution activity needed merely to execute the script.
* It removes the need to synchronize a `package.json`, lockfile, and installed tree for one tiny standalone script.

If dependencies are required, use a committed lockfile and a frozen/CI installation mode. Bun’s package-manager documentation says `bun install` creates `bun.lock` and recommends committing it; it also documents a text format default beginning in Bun v1.2. A lockfile records a reproducible resolution, which is a benefit—not a reason to avoid dependencies categorically.

The symmetric caveat is runtime reproducibility. “No npm dependencies” shifts version control emphasis to the runtime: document/test the Bun version(s), obtain it through a trusted/pinned distribution process, and periodically upgrade it for runtime security fixes. For strict hermeticity, a version constraint in skill prose alone is insufficient; CI and distribution must pin the actual runtime artifact/version. The same applies to Node.

## Shebang and child-process operational notes

1. `#!/usr/bin/env bun` makes a source script directly runnable on Unix only if `bun` is on the caller’s `PATH`; invoking `bun scripts/start.js` is more diagnosable and works independently of executable-bit/shebang setup. Keep the shebang because the skill documentation invokes executable paths, but state Bun as a prerequisite prominently.
2. Do not switch the current `spawn(process.execPath, [watcherPath])` to a literal `node` command. Under Bun it should re-invoke the Bun executable; under Node it would re-invoke Node. This pattern is correct only because `watcherPath` is compatible with the selected runtime.
3. The simple current use of `spawn(... detached, stdio: "ignore").unref()` and `execSync("rsync ...")` does not exercise Bun’s documented child-process gaps (IPC socket handles, uid/gid fields, exported Stream). It *does* depend on OS detachment and process cleanup, so test it on the declared platform(s), including failure paths and port conflicts.
4. `execSync` executes a shell command string. The script quotes its controlled filesystem paths, but new interpolation of untrusted input would be a command-injection risk independent of Bun vs Node. Prefer argument-vector `spawn`/`execFile` for future input-bearing subprocesses.

## Recommended repository selection rule

Use this decision order for a standalone Pi skill:

1. **Start from the required execution environment, not performance claims.** If the skill already requires Bun and accepts its platform contract, Bun built-ins are eligible. If it must run wherever supported Node runs, target Node and state a Node floor.
2. **Prefer the documented built-in** when it covers the exact calls. For browser-style WebSocket clients, Bun global WebSocket and Node >=22.4 global WebSocket qualify; avoid `ws` by default.
3. **Keep/add a dependency only for a demonstrated feature gap.** Examples: Node support below the stable global-WebSocket floor, `WebSocketServer`, Node stream adapters, custom handshake/agent behavior, or a tested protocol/operational need that the built-in does not satisfy.
4. **Treat compatibility shims as a test obligation.** For Bun scripts importing `node:*`, inspect the exact module’s Bun compatibility status. Require smoke/integration coverage for filesystem watches, detached children, process re-exec, and the real external endpoint—not just source-text tests.
5. **Make prerequisites reproducible.** Put the runtime and minimum version in skill metadata; exercise it in CI. When packages are unavoidable, commit a lockfile and use frozen installs. Do not retain unused `node_modules` merely because an earlier implementation had a dependency.

## Short five-bullet recommendation

> **Historical recommendation:** superseded for `web-browser` by the authenticated WebSocket requirement noted above.

* Keep `web-browser` on **Node.js 22.4+** and use the stable built-in WebSocket; do not restore `ws`.
* Use a **built-in-first**, runtime-specific rule rather than “Bun always” or “Node always.”
* Prefer Node when it materially reduces upstream drift or broadens interoperability; prefer Bun when the skill already accepts Bun as a machine prerequisite and its built-ins remove real dependency machinery.
* Retain smoke coverage for `fs.watch`, screenshot writes, detached children, and `process.execPath`, regardless of runtime.
* Use committed lockfiles and frozen installs only when an actual package dependency remains necessary.

## Primary sources

* Bun Node.js compatibility matrix — https://bun.com/docs/runtime/nodejs-compat
* Bun Web-standard APIs (global fetch, WebSocket, encoding/events) — https://bun.com/docs/runtime/web-apis
* Bun WebSocket documentation (including server/client distinction and benchmark conditions) — https://bun.com/docs/runtime/http/websockets
* Bun child-process APIs — https://bun.com/docs/runtime/child-process
* Bun installation/platform documentation — https://bun.com/docs/installation
* Bun package-manager lockfile documentation — https://bun.com/docs/pm/lockfile
* Node v22.13.0 global `WebSocket` documentation and history — https://nodejs.org/download/release/v22.13.0/docs/api/globals.html#websocket
* Node v20.19.0 global `WebSocket` documentation — https://nodejs.org/download/release/v20.19.0/docs/api/globals.html#websocket
* Node release support information — https://nodejs.org/en/about/previous-releases
* Node child-process documentation — https://nodejs.org/api/child_process.html
* Node process documentation — https://nodejs.org/api/process.html
* Official `ws` repository/readme — https://github.com/websockets/ws
* Official `ws` package metadata — https://raw.githubusercontent.com/websockets/ws/master/package.json
