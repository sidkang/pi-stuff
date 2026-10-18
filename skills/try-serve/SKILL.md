---
name: try-serve
description: Share one HTML file or a prepared static directory through a temporary public Cloudflare Quick Tunnel. Use when the user wants a public preview of local HTML or static content.
compatibility: Node.js 18+, screen, cloudflared (on PATH), and outbound internet. No Cloudflare account or npm dependencies required.
---

# Try Serve

Expose a local static preview at a random `https://*.trycloudflare.com` URL. This is a **live tunnel**, not an upload. A named `screen` session keeps the server running after the start command returns; it expires automatically after **30 minutes by default**.

## Commands

```sh
./scripts/try-serve.mjs create /absolute/path/to/page.html
./scripts/try-serve.mjs create /absolute/path/to/static-directory --expire 2h
./scripts/try-serve.mjs inspect
./scripts/try-serve.mjs inspect try-abcde
./scripts/try-serve.mjs kill try-abcde
```

`create` waits for a tunnel URL (up to 60 seconds), then exits while the preview runs in a dedicated `screen` session. Its JSON output has `id`, `session`, `status`, `url`, and `expiresAt`. The ID and session name are both `try-` followed by five lowercase letters. Share the URL and expiry with the user. `inspect` lists all recorded previews or checks a specific ID, identifying a crashed worker as `stale`; `kill` waits for graceful shutdown and returns `stopped`. To stop early, use `kill`, **not** `screen -X quit` (which can orphan `cloudflared`). Expiry accepts positive `s`, `m`, or `h` durations, up to 24 hours.

Select only content intended to be public, not a project root. A directory must contain `index.html`; a standalone HTML file is served at `/index.html`. The server binds only to `127.0.0.1`, rejects symbolic links, and does not list directories. Private runtime state lives in `~/.cache/try-serve/`; expired sessions are removed. The URL is publicly accessible until the process stops; it is not a durable deployment. Quick Tunnels have no uptime guarantee, limit concurrent requests, and do not support SSE. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
