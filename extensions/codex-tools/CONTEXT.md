# Codex Tools

Codex Tools provides provider-aware capabilities while preserving the portability of Pi sessions across providers and models.

## Workspace Language

**Workspace Authority**:
The once-per-execute decision of which adapter owns workspace I/O (Host or Sandbox) and the admitted workspace root for that placement, including fail-closed Workspace Access v2/v1 rules.
_Avoid_: Workspace resolver, access probe, placement helper

**Workspace-backed File Workflow**:
A tool-specific file execution path selected from a resolved Workspace Authority so callers do not re-decide placement or reimplement Host/Sandbox branching.
_Avoid_: Dual host/sandbox helpers, placement switch

## Presentation Language

**Presentation Lifecycle**:
The once-per-execution ownership of which presentation adapter renders a tool call and its terminal result (Better TUI Protocol v1 or native fallback), including sticky family selection, safe discovery failure, and terminal result attempt rules, while tools keep domain-specific semantic presentations and native preview/timer/path behavior.
_Avoid_: Better TUI bridge, renderer helper, presentation fallback chain

## Compaction Language

**Compaction Router**:
The decision point that selects exactly one compaction policy for a compaction attempt from the active provider and model.
_Avoid_: Compaction fallback chain, compaction settings router

**Provider Capability Trust Boundary**:
An explicitly configured provider whose qualifying GPT Responses models are trusted to support the Codex Compaction Policy without per-model capability discovery.
_Avoid_: Model allowlist, runtime capability probe

**Exclusive Policy Owner**:
The sole supported custom replacement policy for a compaction attempt when the extension is explicitly enabled in an API that cannot compose compaction results.
_Avoid_: Highest-priority handler, compaction augmenter

**Compaction Policy**:
The complete contract governing a compaction attempt, including its authoritative representation, portable representation, and failure meaning.
_Avoid_: Summarizer, compaction backend

**Pi Compaction Policy**:
The default policy whose authoritative continuation representation is Pi's portable textual summary.
_Avoid_: Fallback compaction

**Codex Compaction Policy**:
A provider-specific policy whose authoritative continuation representation is a Codex provider artifact and which also produces a portable projection.
_Avoid_: Artifact overlay, remote summary

**Frozen Compaction Input**:
The immutable conversation and request-shape snapshot from which every component of one compaction attempt is produced.
_Avoid_: Current session, live context

**Component View**:
A policy-component-specific view derived from the frozen compaction input; different generators may use different message boundaries without describing different session states.
_Avoid_: Independent snapshot, shared message slice

**Request Semantic Envelope**:
The credential-free provider request settings that define how conversation input is interpreted, observed from a matching request when available and otherwise reconstructed from current public Pi state.
_Avoid_: Request payload, runtime state, authentication context

**Provider Artifact**:
An opaque provider-native checkpoint of context at one compaction boundary, usable only under its compatible provider identity and superseded by a later compaction checkpoint.
_Avoid_: Summary, per-turn state, encrypted summary, portable context

**Valid Provider Artifact**:
A provider artifact accepted by protocol-completion, schema, cardinality, identity, and resource-bound checks without inferring semantic quality from its size.
_Avoid_: High-quality artifact, large artifact

**Artifact Quality Signal**:
Non-secret usage, size, latency, and evaluation data retained for diagnosis and benchmarks but not used as a runtime validity decision without evidence.
_Avoid_: Quality gate, success criterion

**Post-Compaction Tail**:
The context-visible conversation events added after a compaction checkpoint and before the next checkpoint.
_Avoid_: Provider continuation, recent-user retention

**Provider History**:
The replayable provider-native context consisting of retained messages, a provider artifact, and a safely normalized post-compaction tail.
_Avoid_: Pi context, portable summary, provider session

**Provider Replay**:
The request-time use of provider history in place of the portable session representation when policy identity and session parity are valid.
_Avoid_: Provider override, provider continuation, model fallback

**Replay Identity**:
The provider, API, model, and normalized endpoint identity under which a provider artifact may be replayed.
_Avoid_: Model name, provider name

**Portable Projection**:
A readable provider-independent representation of the durable state needed to continue a session when its provider artifact cannot be used or the producing extension is absent.
_Avoid_: Pi summary, fallback summary, placeholder

**Portable Projection Generator**:
A collaborator used inside a compaction policy to produce its portable projection; using Pi's projection algorithm does not transfer ownership to the Pi Compaction Policy.
_Avoid_: Fallback compaction, secondary policy

**Portable Session**:
A persisted session that remains loadable and semantically continuable through standard Pi context when the extension that produced its provider artifact is not installed or active.
_Avoid_: Extension-owned session, artifact-only session

**Pending Compaction Attempt**:
A transient, process-local, uncommitted compaction attempt that retains valid completed components and may resume only while its frozen input and policy identity remain unchanged.
_Avoid_: Partial compaction entry, persisted compaction state, failed session compaction

**Component Failure**:
One generator's inability to produce a valid component while sibling generators remain independent and may complete successfully.
_Avoid_: Policy fallback, attempt cancellation

**Component Retry**:
A continuation of a pending compaction attempt that reruns only its missing or failed component against the same frozen input.
_Avoid_: New compaction, policy fallback

**Attempt Cancellation**:
An explicit abort of the whole compaction attempt that stops all components and retains no pending result.
_Avoid_: Component failure, policy failure

**Policy Failure**:
A selected compaction policy's inability to produce its complete valid result; it does not cause the router to select another policy for the same attempt.
_Avoid_: Provider miss, automatic fallback
