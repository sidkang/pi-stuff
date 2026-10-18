# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`custom-response` API accepted.** Fast mode, `/review`, Responses compaction, and `image_generate` treat it like `openai-responses`. Compaction keeps the selected adapter's transport; review and image requests still use HTTP.
- **Structured `image_generate` results.** Native Pi codemode receives schema-defined image/sidecar metadata, paths, and per-task success/failure data without base64 or prompt content. Text, inline images, partial-success behavior, and thrown failures are unchanged.

### Removed
- **Image generation retired.** Removed the public image tool/status command, generation implementation, settings, rendering, and dedicated tests. Fast mode, code review, and Responses compaction remain.
- **Raw SSE compaction observer and old-host paths.** Artifact capture uses Pi 1.2.0 public provider events, without injected-fetch interception, tee readers, or a parallel response parser. Package tests use the pinned native SDK rather than host-layout searches or skipped old-host probes.
- **Remote-compaction token-budget preflight and `js-tiktoken`.** Compaction sends the unchanged request directly, without local token estimation or budget telemetry. Independent components, Component Retry, Provider Replay, and structured tool results are unchanged.

### Changed
- **Compaction executes through the configured provider.** Native artifacts use the active registry adapter's `stream()`; portable projections supply that adapter's `streamSimple()` to Pi's `compact()`. Both preserve resolved endpoint, headers, and provider-scoped environment. History conversion and replay parity stop the same adapter at its public payload hook without network I/O; internal converter/CLI-path lookup and separate HTTP request construction are removed. Model-ID gating, complete-pair commit, stateless replay, 180-second transport deadline, and zero remote transport retries remain unchanged. The real CLI/RPC E2E now targets Pi 1.2.0.
- **`apply_patch` moved to `apply-patch`.** Codex Tools no longer registers, gates, tests, or documents `apply_patch`. Update with `mise push apply-patch codex-tools`.

- **Web search moved to `web-access`.** Codex Tools no longer registers `web_search` or reads `codexTools.webSearch`. Use `webAccess` in the `web-access` bundle, and update with `mise push codex-tools web-access`.

- **Pi dependency baseline set to 1.2.0.** Runtime `@earendil-works/pi-tui` is pinned to `1.2.0`; peers for `@earendil-works/pi-ai` and `pi-coding-agent` are `^1.2.0`; package-local devDependencies pin `pi-ai`, `pi-agent-core`, and `pi-coding-agent` to exact `1.2.0`. Responses compaction now uses native `buildSessionProjection` on one root-to-leaf snapshot, treats Post-Compaction Tail membership by source entry id after the checkpoint, and fail-closes Provider Replay when a post-checkpoint `context_edit` targets checkpoint/earlier content already inside the opaque artifact.

### Fixed
- **Native compaction works with the actual `custom-response` WebSocket adapter.** The ordered event hook captures the completed artifact without replacing provider transport. Strict completion/output checks reject incomplete or inconsistent artifacts. A 180-second absolute deadline covers connection setup and silent streams after local payload preparation. The companion adapter honors `maxRetries: 0`. Combination tests execute both extensions with the real Pi parser/generator and cover persistence, replay, disconnects, component retry, cancellation, and timeout without HTTP fallback.
- **Large-context native compaction gets a 180-second transport deadline.** The previous 60-second deadline could abort a healthy streaming response before its artifact completed, preventing the complete compaction pair from being committed.
- **Responses compaction works on Pi 1.1.** The CLI entry moved to `dist/bundle/cli.js`, so the message-converter lookup missed and every Codex compaction was cancelled.
- **Structured image failures exclude raw provider previews.** Per-task and aggregate structured error fields use a fixed safe notice, so malformed JSON previews and echoed prompts cannot leak image/prompt payloads. Existing text/details diagnostics and soft-failure behavior are unchanged.
- **Compaction deadline excludes local payload serialization.** The absolute deadline starts after the payload is frozen as JSON; the provider's final wire encoding, connection setup, and response stream are bounded. Caller cancellation is propagated rather than disguised as an artifact miss.
- **ProviderHeaders null deletion markers survive through outbound request construction.** Pi 0.84 can return `null` header values as deletion markers. Image generation, web search, responses compaction, and review keep raw ProviderHeaders until fetch header assembly via shared `buildRequestHeaders`, so `Authorization: null` / `x-api-key: null` omit those headers, keep string headers such as `cf-aig-authorization` / `X-Test`, never serialize the literal `"null"`, and still suppress the Bearer fallback from `apiKey`. Empty `headers:{}` still auto-adds `Authorization: Bearer <apiKey>`.
