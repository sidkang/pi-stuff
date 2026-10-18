# @sidkang/pi-web-access

```sh
pi install npm:@sidkang/pi-web-access
```

Public `web_search`, `x_search`, and `fetch_content` tools for Pi. This bundle is
the sole owner of those tools. Codex Tools no longer registers or configures
search. Search sources are OpenAI, xAI, Exa, and Firecrawl. Fetch sources are
CDP, Exa, and Firecrawl. CDP still attaches to an already-running browser and
extracts markdown with the configured Extraction Kernel (Defuddle by default,
with local html-extractor fallback and an optional openai-responses llm kernel).
The html-extractor kernel is the local `@firecrawl/html-extractor` package; it is
not the Firecrawl hosted source.

## Installation

Install or update this delivery unit only through the repository command. After
extracting search from Codex Tools, update both units in this order:

```sh
mise push codex-tools web-access
```

The bundle has a locked runtime dependency and is installed with the standard
bundle `npm ci --omit=dev` step. Do not install the repository path directly.

## Configuration

Put configuration in Pi `settings.json`:

- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json`

Project settings overlay global settings only in trusted projects. This bundle
reads `webAccess` only. It does not read `codexTools.webSearch`.

```json
{
  "webAccess": {
    "openai": {
      "model": "newapi/gpt-5.4-mini:low"
    },
    "xai": {
      "model": "homelab/grok-4.5:low"
    },
    "fetch": {
      "defaultProvider": "cdp",
      "cdp": {
        "endpoint": "https://browser.example/json/version"
      },
      "maxInlineChars": 30000,
      "extract": {
        "kernel": "defuddle",
        "model": "newapi/gpt-5.4-mini:high"
      }
    }
  }
}
```

`fetch_content` resolves the browser endpoint as `CDP_ENDPOINT`, then trusted
project `webAccess.fetch.cdp.endpoint`, then global `webAccess.fetch.cdp.endpoint`.
There is no localhost default. HTTP(S) roots, including path prefixes such as
`/cdp`, are resolved to `/json/version` before discovery. Direct `ws:` / `wss:`
debugger URLs are used as-is. Optional `CDP_API_KEY` is environment-only and is
never read from `auth.json`. Exa uses `EXA_API_KEY`. Firecrawl keyless access
counts as configured; optional `FIRECRAWL_API_KEY` is also environment-only.

Each model is one provider-qualified string. The first `/` splits the Pi
provider from the model ID; the model ID may contain additional `/`. Both parts
must be nonempty. Web Access resolves the model with
`ctx.modelRegistry.find(provider, modelId)` and
`getApiKeyAndHeaders`.

`webAccess.openai.model`, `webAccess.xai.model`, and
`webAccess.fetch.extract.model` accept an optional Pi thinking-level suffix:

```text
provider/model:level
```

Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. Unsuffixed values preserve current behavior and use `off`; they do not
inherit the session thinking level. Resolution prefers the full model ID first
so models whose IDs contain `:` keep working; only when that full ID is absent
may a final known thinking-level suffix be interpreted. The effective level is
clamped with Pi-native model capability rules. Non-`off` levels are sent through
the existing OpenAI Responses transport as `reasoning.effort` (via the model's
`thinkingLevelMap` when present). Extract completion models must
resolve to `api: "openai-responses"` or `"custom-response"` (still sent over
HTTP). Hosted search source models may keep an
unsuffixed legacy API; setting a thinking suffix on
`webAccess.openai.model` or `webAccess.xai.model` requires one of those two.

Every `web_search` call must explicitly select one `provider`: `openai`, `xai`,
`exa`, or `firecrawl`. Missing or unsupported providers fail before any network
request. An unconfigured or failed source returns an error without trying another
source. Each call retains the 60-second source timeout.

The `all` and automatic source fallback modes, the `merge` parameter, and search
settings `webAccess.defaultProvider` / `webAccess.merge` have been removed. Old
settings are ignored; they do not supply a missing provider. Callers must choose
a provider for every call. Fetch defaults and Extraction Kernel fallback are
unchanged. There is no public timeout or instructions setting.

`x_search` uses only the configured xAI model. It does not fall back to web
search.

## Tools

### `web_search`

Required parameters: `query`, `provider`. Optional parameters: `limit`,
`search_context_size`, `allowed_domains`, `user_location`.

| Provider | Result | Configuration |
| --- | --- | --- |
| `openai` | Model-written answer and citations | `webAccess.openai.model` |
| `xai` | Model-written answer and citations | `webAccess.xai.model`, via CLIProxyAPI |
| `exa` | URLs and excerpts | `EXA_API_KEY` |
| `firecrawl` | URLs and excerpts | Keyless supported; optional `FIRECRAWL_API_KEY` |

Honor a source requested by the user; otherwise choose one appropriate to the
task. After a failure, the caller decides whether to make a separate call with
another source. No call fans out or automatically switches sources.

- OpenAI keeps the previous Responses `web_search` request: forced
  `tool_choice: { type: "web_search" }`, `search_context_size` default `high`,
  allowed domains, and country sanitization.
- Country codes are trimmed and uppercased only when they are exactly two ASCII
  letters. Names and 3-letter forms are omitted. `user_location` is omitted when
  no fields remain.
- xAI uses the same configured Responses endpoint and native
  `tools: [{ type: "web_search" }]` with forced
  `tool_choice: { type: "web_search" }`. If CLIProxyAPI rejects that forced
  choice shape, Web Access retries once without `tool_choice`; this is a shape
  compatibility fallback, not a general transport retry. It does not send
  `search_context_size` or `user_location`.
- xAI accepts at most 5 allowed domains. More than 5 is an invalid-input
  attempt for that source; domains are not truncated.
- Exa calls `POST https://api.exa.ai/search` with `numResults` (default 10; public
  tool `limit` max 20) and `contents.highlights`. It requires `EXA_API_KEY`.
- Firecrawl calls `POST https://api.firecrawl.dev/v2/search` with `limit` (default
  10; public tool max 20) without scraping result pages. Keyless access is allowed.
  Both hosted retrieval sources forward the public `limit` without extra local
  slicing when the upstream API accepts the same range.

Success is a nonempty answer or at least one source.

### `x_search`

Parameters: required `query`, optional inclusive `from_date`, and optional
inclusive `to_date`. Dates use `YYYY-MM-DD`; Web Access validates real calendar
dates and requires `from_date` to be on or before `to_date` when both are set.

The first request sends native `tools: [{ type: "x_search", ...dateRange }]`
with `tool_choice: { type: "x_search" }`. If that request is rejected
specifically as an unsupported or invalid tool-choice shape, Web Access retries
once without `tool_choice` while preserving the date range. That retry is shape
fallback, not a general transport retry.

`x_search` is the public xAI server-side tool. The server may internally choose
keyword search, semantic search, user search, or thread fetch; Web Access does
not expose those internal operations as separate tools.

Success requires assistant text plus either an `x_search_call` output item or a
citation/annotation URL on `x.com` or `twitter.com`.

### `fetch_content`

Parameters: `url`, optional `provider` (`cdp`, `exa`, or `firecrawl`), and optional
`kernel` (`defuddle`, `html-extractor`, or `llm`). Omitted `provider` uses
`webAccess.fetch.defaultProvider`, then `cdp`. There is no fetch fallback across
sources. `kernel` selects the Kernel Fallback starting point for CDP only and is
ignored for Exa and Firecrawl.

The `cdp` source attaches to an already-running browser through CDP, opens a
background tab, waits for bounded dynamic readiness, performs bounded
incremental lazy-load scrolling, captures HTML under a hard size limit, extracts
markdown with the selected Extraction Kernel, and closes only that tab.
Endpoint resolution is `CDP_ENDPOINT`, then trusted project
`webAccess.fetch.cdp.endpoint`, then global `webAccess.fetch.cdp.endpoint`.
HTTP(S) roots, including path prefixes such as `/cdp`, are resolved to
`/json/version` before discovery. Optional `CDP_API_KEY` is environment-only.

Dynamic readiness treats main-frame `load` as a coarse milestone only. After
navigation, Web Access samples the semantic main content and waits for a short
minimum observation period plus relevant-network quiet (Document/XHR/Fetch/Script)
and DOM stability. Image, font, media, and WebSocket traffic do not block
readiness. Lazy-load scrolling is incremental and hard-bounded by elapsed time,
step count, total viewport distance, and repeated no-growth; it never scrolls
until the page bottom. Captured HTML is size-checked inside the page with
`TextEncoder` before transfer (64 MiB UTF-8). Oversized pages fail without
sending HTML through CDP; inbound CDP WebSocket messages are also hard-capped
at 128 MiB before parse.

`webAccess.fetch.extract.kernel` selects the default `defuddle`,
`html-extractor`, or `llm` kernel. Kernel Fallback starts at the per-call
`kernel` when present, otherwise at the configured default:

- `defuddle`: Defuddle → local `@firecrawl/html-extractor` → configured llm
- `html-extractor`: html-extractor → configured llm
- `llm`: llm only

The `exa` fetch source calls Exa Contents and requires `EXA_API_KEY`. The
`firecrawl` fetch source calls Firecrawl Scrape; keyless access counts as
configured. Hosted fetch sources return already-extracted text and do not use an
Extraction Kernel. Invalid project kernel values clear inheritance and resolve to
Defuddle; missing project leaves preserve global values.

`webAccess.fetch.extract.model` is an optional provider-qualified Model Registry
model used only by the llm kernel. It must resolve to `openai-responses` or
`custom-response`.
Missing project leaves preserve a global model; an explicit blank or invalid
project model clears inheritance. When llm is reached from a local selection
without a configured model, it is skipped. Direct `kernel: "llm"` without a
model fails clearly. The llm kernel builds a new tool-free Responses completion
context, hard-truncates captured page data (80,000 characters), marks that
payload as untrusted, and never uses the session model as an implicit extract
model. Reaching the llm kernel sends bounded content that was visible to the
logged-in browser to the configured model provider.

Each call has one shared 60-second deadline covering acquisition and every
attempted kernel. Local HTML normalization and Defuddle/html-extractor kernels
run in a killable worker thread so that deadline/cancellation can terminate
synchronous parse work; the llm kernel stays on the main thread with the Model
Registry. Main-frame document requests and redirects receive best-effort static
URL checks (http(s), hostname denylist, and IP-literal local/private/metadata
ranges) before continue/fail. These checks are not full SSRF isolation: Agent-local
DNS is not treated as proof of the remote browser's resolved address.
Model-facing inline markdown defaults to 30,000 characters and caps at 200,000
through `webAccess.fetch.maxInlineChars`. This is a display limit, not a
programmatic result limit. Result details name the Fetch Source and, for CDP,
the kernel that actually produced the markdown.

The collapsed fetch view is a short preview. Its expanded TUI view is still a
bounded preview: it shows the head and tail of the returned markdown with a
middle omission marker. When the inline view is truncated, the status shows
`returned / total chars`; the warning identifies the structured result or
complete-output file containing the omitted tail.

### Structured results and codemode

On the tested Pi **0.99.1, 0.99.2, and 1.1.0** releases, all three tools declare `outputSchema` and return
`structuredContent`. Native codemode scripts receive that object, while direct
model calls and native/Better-TUI rendering keep their short text content.
Tool exposure and Source Selection are unchanged. Annotations are unverified
read-only, non-destructive, non-idempotent, open-world hints, not permissions:
the existing `tool_call` permission pipeline still applies to nested calls.

Search objects contain `query`, `answer` (empty string for retrieval-only
results), `sources` (`title`, `url`, optional `snippet` and `publishedDate`),
`citations` (`title`, `url`, optional `citedText`), and `citationUrls` (structured
citations only, not answer-scraped links). Source metadata includes `source`,
`provider`, `model`, `api`, elapsed/timeout milliseconds, and, when supplied by
the backend, `requestId` and token `usage`. Raw response items and request
headers/credentials are not exported.

Fetch objects contain `requestedUrl`, final `url`, `title`, `markdown`, `source`,
optional actual `kernel`, retrieval-completion time `retrievedAt` (ISO UTC), and
`elapsedMs`. Counts use JavaScript UTF-16 characters except `totalBytes`, which
is UTF-8. The following fields distinguish display from complete data:

| Field | Meaning |
| --- | --- |
| `totalChars`, `totalBytes` | Complete extracted markdown size, not the original HTML/page size |
| `returnedChars`, `truncated` | Inline markdown size and whether the short model/TUI view omitted a tail (excludes the warning) |
| `structuredChars`, `structuredTruncated` | `markdown.length` and whether markdown was moved out of the structured object |
| `fullOutputPath` | Present only when the complete extracted markdown is in a temporary file |

Up to **512 KiB UTF-8**, scripts receive the complete markdown, including tails
beyond `maxInlineChars`. Larger results return `markdown: ""`,
`structuredChars: 0`, `structuredTruncated: true`, and `fullOutputPath`; no
partial string is silently substituted. The complete UTF-8 `.md` file is
created exclusively with mode **0600** inside a unique **0700** OS temporary
directory. It contains extracted page text only, never request headers or
authentication configuration. It can contain private logged-in page data.
For ordinary lines, use the native `read` tool with bounded `offset`/`limit`
calls (the tool must be active/available and permitted). Pi 0.99.1/0.99.2 `read` is
line-based: a first selected line over **50 KiB** returns only a "Use bash"
diagnostic. Increasing the line offset skips that line; it cannot recover its
tail. For oversized single-line markdown, use the bounded native `bash`
byte-range example below, never load the entire spill into QuickJS.
Spills are deleted at orderly session shutdown/reload, not durable across
resumption; abrupt process termination may leave owner-only files for OS/manual
cleanup. Do not share their paths or contents unnecessarily.

Complete output has a **64 MiB** hard per-result UTF-8 bound. Session spills are
limited to **8 files / 128 MiB**, with concurrent reservations counted before
writing. Exceeding either limit fails the tool instead of silently losing a
tail. Existing HTTP (1 MiB), CDP HTML (64 MiB), WebSocket (128 MiB), llm input,
timeout, cancellation and Kernel Fallback limits still apply. "Complete"
means the extracted markdown, not data already omitted by the acquisition
source, browser, or bounded llm kernel.

```js
const found = await tools.web_search({ query: "Pi SDK", provider: "firecrawl" });
const urls = [...new Set(found.sources.map(s => s.url.split("#")[0]))];
const page = await tools.fetch_content({ url: urls[0], provider: "firecrawl" });
if (page.structuredTruncated) {
  // Ordinary short lines only; see the byte-range fallback for oversized lines.
  text(await tools.read({ path: page.fullOutputPath, offset: 1, limit: 100 }));
} else {
  text(page.markdown.slice(-1000));
}
```

The following fallback requires **native `bash` explicitly available and
allowed**, and a trusted `node` executable on `PATH`; this extension does not
enable or override bash. For example, an authorized invocation can include
`--tools codemode,web_search,fetch_content,read,bash`. Availability is not
permission: `tools.bash` still traverses Pi's native `tool_call` approval and
`tool_result` pipeline. If bash is unavailable or denied, stop and obtain an
authorized loadout/approval; do not bypass it through another execution path.

This helper requests at most **4096 bytes** per call from the exact returned
`fullOutputPath`, without rewriting the spill. Offsets/counts are UTF-8 **byte**
positions, not JavaScript character or line positions. It returns exact bytes
as base64 and a strict UTF-8 decoding only when both range boundaries align
with code points; otherwise `utf8` is `null`. Use base64 for exact byte
reassembly outside QuickJS, or adjust/overlap bounded ranges by up to three
bytes to align UTF-8 boundaries. Do not concatenate a whole large file inside
QuickJS. Shell arguments, including paths with quotes/metacharacters, are
single-quoted data; the Node program is fixed code, never interpolated page
text or untrusted shell code. A failed native bash command resolves to its
native structured result with a nonzero `exit_code`; the helper checks that
and output truncation before parsing.

```js
// Bounded spill byte ranges through available, permitted native bash.
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
async function readSpillBytes(path, offset, count) {
  if (typeof tools.bash !== "function") throw new Error("Native bash is unavailable");
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(count) || count < 1 || count > 4096) {
    throw new Error("Expected a nonnegative byte offset and 1..4096 byte count");
  }
  const reader = `
    const fs = require("node:fs");
    const [path, start, length] = process.argv.slice(1);
    const offset = Number(start), count = Number(length);
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(count) || count < 1 || count > 4096) throw Error("Invalid byte range");
    const fd = fs.openSync(path, "r");
    try {
      const buffer = Buffer.alloc(count);
      const bytesRead = fs.readSync(fd, buffer, 0, count, offset);
      const bytes = buffer.subarray(0, bytesRead);
      let utf8 = null;
      try { utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch {}
      console.log(JSON.stringify({ offset, bytesRead, base64: bytes.toString("base64"), utf8 }));
    } finally { fs.closeSync(fd); }
  `;
  const command = "node -e " + shellQuote(reader) + " -- " +
    [path, offset, count].map(shellQuote).join(" ");
  const result = await tools.bash({ command, timeout: 10 });
  if (result.exit_code !== 0 || result.truncated) throw new Error("Bounded spill read failed");
  return JSON.parse(result.output);
}
```

For example, after fetching an oversized page, inspect its last bounded byte
range with `text(await readSpillBytes(page.fullOutputPath,
Math.max(0, page.totalBytes - 4096), Math.min(4096, page.totalBytes)))`.
`utf8: null` signals a split code point, not missing bytes: the exact base64
payload remains available. Inspect only needed ranges instead of emitting
every chunk to the model.

Hard failures still **throw**. Pi persists a true `isError: true` direct tool
result, with diagnostic `details` restored by the error hook; no successful
`ok: false` object or structured failure is returned. Native codemode nested
calls reject; use `try/catch` or `Promise.allSettled` if scripts need to handle
them. Error hooks only restore `details` and never recreate redacted structured
data. Other extensions that redact `content` must also replace
`structuredContent`, or Pi deliberately drops the structured data.

## Validation

`npm test` includes unit/schema regressions and the real native codemode E2E;
the repository's root test discovery already invokes this script.
`npm run test:e2e` runs the E2E alone. `npm run typecheck` checks every TypeScript
source against the **actual Pi 0.99.1, 0.99.2, or 1.1.0 declarations**, not the older locked
development host. The old development dependencies remain for the existing
compatibility unit tests; no broad dependency migration is required.

Host discovery checks the local installed package, then the `pi` executable on
`PATH` (including Homebrew layouts). For portable/explicit selection, set
`PI_WEB_ACCESS_HOST=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent`.
Only these two tested releases are accepted. Explicit overrides are exclusive:
empty, missing, malformed, wrong-package, incomplete or unsupported hosts fail
without falling back. Both E2E and typecheck fail rather than skip; E2E also
asserts the loaded SDK's `VERSION` matches the selected package metadata.
E2E binds `PI_PACKAGE_DIR` to the selected SDK before import so inherited launcher
metadata/assets cannot select a different release, then restores it on cleanup.
The E2E uses `DefaultResourceLoader`, this unit's file entry point, SDK sessions,
real extension registration/tool dispatch, native `createCodemodeExtension`
and QuickJS conversion. Only model responses and external HTTP responses are
deterministic fixtures. Owner-only temporary agent/workspace directories keep
settings, credential placeholders and persisted sessions away from user
profiles; no paid APIs, browser login, install or sync is involved. Coverage
includes structured answering/X search, retrieval search → deduplicate/filter
→ fetch, complete inline tails, secure multiline/single-line spills, native
read and permission-checked bounded bash byte reads with UTF-8 boundary checks,
persisted errors, nested rejection, permission blocking, structured redaction,
and cancellation traversing nested events and the HTTP abort signal. Orderly
shutdown deletes spills; test temporary storage and environment/fetch overrides
are cleaned up on exit.

## Compatibility

xAI traffic goes only through a configured Pi/CLIProxyAPI model. Direct official
xAI endpoints such as `api.x.ai` are rejected, including when authentication
overrides the model `baseUrl`. A proxy route may keep any Pi provider name,
including `xai`, as long as the resolved URL is not an official xAI host. This
bundle does not implement a direct xAI key, OAuth, browser cookies, or
credential files.

CLIProxyAPI v7.2.97 accepts both native tools but automatically injects
`x_search` into upstream xAI Responses requests. Web Access requests the
intended tool and cannot guarantee web-only upstream search through this proxy.

## Rendering

`web_search` keeps the previous Better TUI Presentation Lifecycle and native
fallback. `x_search` uses the same compact presentation with X-specific action
and labels. `fetch_content` uses a separate Fetch Content presentation rather
than Web Search or X Search labels. Untrusted display fields are stripped of
terminal controls at native render boundaries; Better TUI sanitizes downstream.
Model-facing tool content is not altered by terminal sanitation. Backend HTTP
bodies (including CDP discovery JSON) share a 1 MiB envelope; captured HTML and
CDP WebSocket frames keep separate 64 MiB / 128 MiB ceilings. Auth and request
secrets are not persisted.
