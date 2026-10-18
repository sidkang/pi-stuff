---
name: web-browser
description: "Automate and interact with web pages through Chrome or Chromium using the Chrome DevTools Protocol (CDP): navigate, click, fill forms, inspect content, take screenshots, and debug console or network activity. Use when an agent needs a real browser. Prefer a configured CDP_ENDPOINT; if it is unavailable, ask before launching an isolated local Chrome, using headless mode unless visible interaction is required."
compatibility: Bun 1.3+; Chrome or Chromium with remote debugging enabled
license: Apache-2.0
metadata:
  upstream:
    repo: mitsuhiko/agent-stuff
    path: skills/web-browser
    commit: 13bc8f87970bec8830aab0f1c0487d35aa7c0917
    status: modified
    notes:
      - local: use Bun's built-in WebSocket instead of upstream ws, including authenticated CDP WebSocket handshakes, with no npm dependency files.
      - local: retain package-specific Bun versus Node research under `docs/research/`.
      - local: clarify the Apache-2.0 license and preserve the upstream Mario attribution; record local changes here without repeating notices in helper scripts.
      - local: adapt skill routing and connection behavior to prefer CDP_ENDPOINT with optional CDP_API_KEY, and require user confirmation before bypassing it with --local.
      - local: resolve HTTP(S) CDP roots, including path prefixes such as /cdp, to /json/version before discovery.
      - local: handle cookie dialogs only when needed for the task; accepting optional tracking requires the user's choice rather than automatic consent.
---

# Web Browser Skill

Minimal CDP tools for collaborative site exploration.

Upstream attribution: "Stolen from Mario".

## Connection Priority

If `CDP_ENDPOINT` is set, browser commands use it before the local Chrome endpoint. `CDP_API_KEY` is optional; HTTP endpoints try it first as a Bearer token, then as `X-API-Key` after a `401` or `403` response.

`CDP_ENDPOINT` may be an HTTP(S) endpoint that returns `webSocketDebuggerUrl`, or a direct WS(S) debugger URL. HTTP(S) roots, including path prefixes such as `/cdp`, are resolved to `/json/version` before discovery. Do not print these variables or include their values in error messages.

If the external endpoint fails, **stop and ask the user whether to create/use the isolated local browser**. Only after confirmation, add `--local` to each browser command:

```bash
./scripts/start.js --headless --local
./scripts/nav.js https://example.com --local
./scripts/eval.js 'document.title' --local
```

Without explicit confirmation, do not fall back to local Chrome. Pi and these scripts do not automatically load `.env.local`; provide the variables in the environment that starts Pi.

## Start Chrome (Prefer Headless)

```bash
./scripts/start.js --headless            # Recommended: isolated reusable profile
./scripts/start.js --headless --profile  # Headless with a copy of your profile
./scripts/start.js                       # Visible browser window when needed
./scripts/start.js --headless --reset-profile  # Clear cached profile before launch
```

When `CDP_ENDPOINT` is configured, `start.js` refuses to start unless `--local` is present.

Starts Chrome with remote debugging (default port `:9222`). **Agents should use `--headless` by default** because it is less disruptive and supports navigation, evaluation, screenshots, emulation, and logging. User extensions are disabled for headless launches; a copied profile still provides its cookies and other browser state, but extension-based features are unavailable. Headed launches continue to load extensions normally. Use headed mode only when a person needs to see or interact with the browser, such as for `pick.js`, manual authentication, or debugging a headless-specific difference.

The start script only reuses a running browser when its profile and launch settings match. Close the running skill browser before switching between headless and headed mode.

Profile behavior:
- Default mode uses: `~/.cache/agent-web/browser/fresh-profile`
- `--profile` mode uses: `~/.cache/agent-web/browser/profile-copy`
- The skill **does not attach to your live Chrome profile directly**
- If `:9222` is already used by an unknown instance, start will fail instead of reusing it

If Chrome is installed in a non-standard location, set:

```bash
BROWSER_BIN=/path/to/chrome ./scripts/start.js --headless
```

Optional debug endpoint override:

```bash
BROWSER_DEBUG_PORT=9333 ./scripts/start.js --headless
```

## Navigate

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

Navigate current tab or open new tab.

## Device Emulation (Mobile)

```bash
./scripts/emulate.js --list
./scripts/emulate.js iphone-14
./scripts/emulate.js pixel-7 --landscape
./scripts/emulate.js --reset
```

Set an active device emulation preference (viewport, DPR, touch, UA) for browser skill commands. Use `--reset` to clear.

Commands like `nav.js`, `eval.js`, `pick.js`, `dismiss-cookies.js`, and `screenshot.js` automatically apply the active preference.

## Evaluate JavaScript

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'document.querySelectorAll("a").length'
./scripts/eval.js 'document.querySelector("button")?.click(); "clicked"'
./scripts/eval.js 'await Promise.resolve(document.title)'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Execute JavaScript in the active tab. Input can be an expression or statement list; the console-style completion value is printed and promises/top-level `await` are awaited. Be careful with string escaping, best to use single quotes.

## Screenshot

```bash
./scripts/screenshot.js
./scripts/screenshot.js --full-page
./scripts/screenshot.js --device iphone-14
./scripts/screenshot.js --device pixel-7 --full-page
```

Takes a screenshot and returns a temp file path.

- Default: current viewport
- `--full-page`: captures full document height
- `--device <preset>`: temporary mobile emulation for that screenshot only

## Pick Elements

```bash
./scripts/pick.js "Click the submit button"
```

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish. This requires headed Chrome; launch `start.js` without `--headless`.

## Dismiss Cookie Dialogs

Handle a cookie dialog only when it blocks the requested task. Inspect the choices first. Reject optional cookies where possible; if the site requires acceptance to proceed, ask the user. Accept optional tracking only when the user chooses it.

```bash
./scripts/dismiss-cookies.js --reject # Reject optional cookies where possible
```

The script without `--reject` attempts to accept cookies. Use that form only after the user chooses acceptance. Do not run either form automatically after navigation. Verify the result; dialog controls vary by site.

## Quick Mobile Debug Flow

```bash
./scripts/start.js --headless
./scripts/nav.js https://example.com
./scripts/emulate.js iphone-14
./scripts/nav.js https://example.com      # reload with mobile UA
./scripts/screenshot.js --full-page
```

## Background Logging (Console + Errors + Network)

Automatically started by `./scripts/start.js` and writes JSONL logs to:

```
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

Manually start:
```bash
./scripts/watch.js
```

Tail latest log:
```bash
./scripts/logs-tail.js           # dump current log and exit
./scripts/logs-tail.js --follow  # keep following
```

Summarize network responses:
```bash
./scripts/net-summary.js
```
