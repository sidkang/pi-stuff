---
status: accepted
---

# Use one provider-aware replacement compaction policy

Pi's public compaction hook supports complete replacement but not additive or composable augmentation. Codex Tools therefore routes each attempt to exactly one policy: unmatched models use Pi's default policy, while explicitly enabled trusted providers use an exclusive Codex policy. The Codex policy produces a provider-native artifact from the full provider view and a portable projection by reusing Pi's compaction algorithm over Pi's preparation view; only the complete pair is committed as a standard Pi `CompactionEntry`, so sessions remain usable when the extension is absent.

The two components run independently from one frozen session snapshot. A single successful component may be retained only in a process-local pending attempt, and a subsequent `/compact` resumes the missing component if the input is unchanged. Component failure does not select the Pi policy; the attempt is cancelled, including during overflow recovery, and the interrupted turn must be continued explicitly after a successful retry. Remote transport is attempted once per component execution, protocol-valid artifacts are accepted regardless of size, and quality metadata is observational rather than a runtime gate.

Provider replay remains stateless and uses `before_provider_request`, not a provider override or reliance on WebSocket continuation, `store: true`, or `previous_response_id`. A provider artifact is a checkpoint, so compatible later requests use that artifact plus a safely normalized post-compaction tail, including portable turns produced by other models. A later compaction checkpoint supersedes it. Replay requires strict provider, API, model, and normalized endpoint identity and fails closed when the tail or outbound session parity cannot be validated.

## Consequences

- Responses compaction remains disabled by default; enabling it declares the configured provider list to be a capability trust boundary and Codex Tools to be the sole supported custom compaction replacement owner.
- Other providers and sessions opened without the extension consume the portable projection through standard Pi session semantics and may ignore all custom details.
- Reusing Pi's exported `compact()` avoids duplicating its cut-point, previous-summary, split-turn, file-tracking, and usage behavior. Its stream function delegates to the active registry provider's `streamSimple()`, with resolved headers, endpoint, and provider-scoped environment. Native artifact generation delegates to the same provider's `stream()` without selecting or replacing its transport. Pi 1.2.0 ordered `onProviderStreamEvent` callbacks supply the artifact and usage, with zero transport retries.
- History conversion and replay parity use the selected adapter's public `onPayload` hook and stop before dispatch. There is no internal converter import, CLI/package-layout lookup, or direct-fetch execution bypass. Adapters must honor the public payload, ordered provider-event, and cancellation contracts; unsupported adapters fail the selected policy. There is no raw-response parser, injected-fetch observer, second stream reader, or HTTP fallback. Completion status, terminal artifact cardinality, item/terminal consistency, and a cumulative structured-event byte budget are validated before publication. Session-specific SDK overrides and active WebSocket continuation remain outside the public compaction context.
- Cross-model turns do not by themselves invalidate an artifact; provider-private reasoning is excluded while portable text and valid tool interactions are normalized into the replay tail.
