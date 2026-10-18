# codex-tools

Provider-aware compaction, fast mode, and explicit code-review commands for Pi.
Public `apply_patch` lives in the `apply-patch` bundle. Public `web_search` and
`x_search` live in the `web-access` bundle.

## Installation

Install or update this delivery unit only through the repository command. After
`apply_patch` moved to Apply Patch, update both units in this order:

```sh
mise push apply-patch codex-tools
```

The bundle has a locked runtime dependency and is installed with the standard
bundle `npm ci --omit=dev` step. Do not install the repository path directly.
Legacy `plugins/codex-tools/` is not an accepted `mise push` source.

## Execution boundary

Review commands and Responses compaction remain Host-side. They do not register
execution backends or use Sandbox Workspace Access.

## Code review

This package registers two user-only commands; it does **not** register a model-callable review tool and never triggers an automatic fix turn:

```text
/codex-review [--working-tree | --base <ref> | --commit <rev> | --custom <instructions>]
/codex-adversarial-review [--working-tree | --base <ref> | --commit <rev>] [--focus <text>]
```

With no target, review prefers a dirty working tree. Otherwise it compares Git `HEAD` with the discovered default branch, or JJ `@` with `trunk()`. If the Git default branch cannot be resolved, pass `--base` explicitly. Git targets include staged, unstaged, and untracked files. JJ creates one unintegrated snapshot operation, pins every subsequent read to that operation with `--ignore-working-copy`, and remains the selected backend for colocated repositories. Both commands refuse unresolved conflicts and only accept an inline review scope of at most two files and a 256 KiB diff (an untracked file is limited to 24 KiB). Empty scopes report `No changes to review.`

The command freezes VCS status, immutable identifiers, stat, changed paths, and diff before sending an OpenAI Responses request. The diff is explicitly wrapped as untrusted evidence. Native review uses the upstream Codex rubric without a JSON-schema request; adversarial review uses its upstream strict JSON schema. Results are displayed as a custom session message with `triggerTurn: false`, so review never starts an agent turn or a background job. Invalid, malformed, or hallucinated finding paths are discarded and the review is marked inconclusive/needs-attention rather than approved.

Configure only this settings block; project settings overlay global settings only in trusted projects:

```json
{
  "codexTools": {
    "review": {
      "provider": "newapi",
      "model": "gpt-5.6-sol",
      "effort": "high",
      "timeoutMs": 300000
    }
  }
}
```

The selected model must resolve through Pi's model registry, use `api: "openai-responses"` or `"custom-response"`, and have a GPT model ID. The command sends exactly one `POST /responses` request with Pi-resolved authentication, no Codex-specific headers, no retries, bounded response buffering, cancellation, and timeout handling. A real configured provider/model is still required for a live probe.

## Configuration best practices

Put configuration in Pi `settings.json`:

- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json`

Do **not** put Codex Tools config in `plugin-settings.json`.

### Canonical settings key

Use a single top-level key:

```json
{
  "codexTools": {}
}
```

Use camelCase inside that block too.

### Recommended shape

```json
{
  "codexTools": {
    "fastMode": {
      "eligibleModels": ["gpt-5.4", "gpt-5.5"],
      "defaultEnabledModels": ["gpt-5.5"]
    },
    "responsesCompaction": {
      "enabled": true,
      "providers": ["newapi"]
    }
  }
}
```

### Notes

- Project settings override global settings only for trusted projects.
- `apply_patch` is owned by the `apply-patch` bundle.
- `fastMode.eligibleModels` matches only the active model ID, not its provider. Provider-qualified values such as `newapi/gpt-5.5` are ignored.
- `fastMode.defaultEnabledModels` is limited to models in `fastMode.eligibleModels`. These models start with Fast Mode enabled; `/fast` and `/unfast` change the selected model's state for the current session.
- The legacy top-level `fastModels` setting is not recognized.

## Responses compaction

For matching GPT Responses models, Codex Tools can use the OpenAI Responses compaction v2 endpoint through the model's already configured provider authentication. It is disabled by default and must be explicitly enabled for selected providers:

```json
{
  "codexTools": {
    "responsesCompaction": {
      "enabled": true,
      "providers": ["newapi"]
    }
  }
}
```

`responsesCompaction` accepts only `enabled` and `providers`. This is an experimental, exclusive replacement policy: it requires host Pi `1.2.0` or newer (`buildSessionProjection` / `context_edit` and the public provider-event contract). Other `session_before_compact` adapters are load-order competitors; leave it disabled when another compaction extension is active. A configured provider is a capability trust boundary; its model is eligible only when it uses `api: "openai-responses"` or `"custom-response"` and its ID contains `gpt` (case-insensitively). This model-ID gate is unchanged.

For an eligible model, Codex Tools generates Pi's portable projection and the provider-native artifact concurrently from one frozen session snapshot. The remote request prefers the latest matching request's credential-free semantic shape (`instructions`, system/developer prefix, active tools, tool choice, parallel-tool setting, `reasoning`, and `text`) and reconstructs missing fields from public Pi state. One component failing does not cancel the other. A partial success is retained only in process memory; running `/compact` again without changing the session retries only the missing component. Reloading Pi discards that pending optimization and reruns both components. No hidden remote transport retry is performed.

Both generators use the active registry provider, including its resolved authentication,
endpoint, headers, provider-scoped environment, and request transformations. Pi's
`compact()` still owns the portable projection algorithm, with the selected adapter's
`streamSimple()` supplied as its stream function. The native component uses that
adapter's `stream()` instead of constructing a separate HTTP request. History
serialization and replay parity use the same adapter's public `onPayload` hook,
stopping before dispatch; preparation makes no network request. No internal
message converter or CLI/package-path lookup remains.

Artifact collection uses the adapter's ordered `onProviderStreamEvent` hook, not
injected fetch, raw SSE parsing, or a second response reader. Both HTTP/SSE and
`custom-response` WebSocket transport keep their provider-owned execution path.
The completed response must have status `completed` and exactly one non-empty
compaction item in its terminal output; item-done events, when present, must agree.
Observed structured events have a cumulative 40 MiB UTF-8 JSON budget. Events
are read-only, and only the canonical artifact and non-secret usage are retained.

Custom adapters must honor `onPayload`, ordered `onProviderStreamEvent`, and
cancellation. Missing events or invalid output fail the selected policy; there
is no raw-fetch bypass or HTTP fallback. Maintenance requests use no session
affinity, `store: false`, no `previous_response_id`, and `maxRetries: 0`. The
companion `custom-response` honors zero retries even for an early socket close.
Session-specific SDK overrides not exposed by Pi remain outside this contract.

Remote requests are sent without local token-budget estimation or input
truncation. The 180-second absolute deadline starts after local payload JSON is
frozen; it covers the adapter's final wire encoding, connection setup, and complete
response parsing, including a silent WebSocket. Caller cancellation covers the
entire attempt.

Only a complete portable-projection/artifact pair is committed. Once an eligible route is selected, component failure cancels compaction instead of falling back to Pi; during overflow recovery this also interrupts the original turn, so after a successful `/compact` retry the user must explicitly continue it. The standard Pi summary remains sufficient when the extension is disabled or absent. Provider details contain the newest real user messages within an approximately 20K-token budget (including a cumulative 1 MiB retained-image budget), followed by exactly one opaque artifact and non-secret usage/latency telemetry.

Replay is stateless and does not override the provider, enable `store`, or use `previous_response_id`. It requires the exact provider, API, model ID, and normalized base URL. A model/provider switch does not by itself invalidate the checkpoint: when switching back, portable cross-provider text and valid tool interactions after the checkpoint are normalized and appended, while provider-private reasoning is removed. Post-checkpoint `context_edit` applies to the Post-Compaction Tail only. An edit aimed at the checkpoint or earlier content already represented by the opaque artifact disables Provider Replay and forces the next compaction to build a new artifact from the current projection. A later compaction checkpoint, invalid artifact, unsafe tail, or outbound session-parity mismatch likewise disables artifact replay for that request and leaves Pi's normal portable context unchanged. Session projection failures cancel a matched compaction and skip replay. Hosts older than Pi `1.2.0` are unsupported; there is no older-host compatibility path.

## End-to-end verification

From a checkout with both `codex-tools` and `apply-patch` dependencies installed:

```sh
PI_PACKAGE_DIR=/path/to/pi-coding-agent npm --prefix packages/extensions/codex-tools run test:e2e
```

The test targets native Pi 1.2.0 and starts its real CLI/RPC agent with the native
codemode extension. It covers patch execution/files, persisted compaction/replay,
provider failure and Component
Retry, then resumes the persisted session without Codex Tools. HTTP/SSE provider
responses are local fixtures; this does not prove production API behavior or
semantic artifact quality. Profiles/workspaces are temporary; no installation,
synchronization or production credentials are used. The command
prints the retained request/event/report artifact directory.

`npm test` also runs the actual `custom-response` extension source with the real
Pi 1.2.0 Responses parser and compaction generator; only its socket/server is a
fixture. This combination verifies network-free preparation, artifact capture,
complete-pair persistence/replay, early and mid-stream disconnects, Component
Retry, caller cancellation, and the absolute deadline. HTTP is forbidden in this
fixture so a transport bypass cannot pass unnoticed.

## Removed capability

Image generation is no longer part of Codex Tools and is not maintained here.
Remove its old configuration and tool allowlist entries when updating. Existing
generated files are not deleted.
