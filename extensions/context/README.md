# context

A standalone Pi extension that adds `/context`, an overview of the current
context window, system and tool estimates, loaded project instructions,
extensions, skills, and accumulated session usage.

## Behavior

In TUI mode, `/context` opens a summary/details view. Press Tab to switch views
and Esc, Ctrl+C, `q`, or Enter to close it.

In RPC, JSON, and print modes, the command appends a `context:report` custom
entry. Custom entries do not participate in model context. RPC and JSON clients
can consume the resulting `entry_appended` event; print mode has no interactive
renderer for the entry.

The overview uses Pi's current system-prompt inputs rather than rescanning
project instruction files from disk. Window usage comes directly from
`ctx.getContextUsage()`; tool and system figures are approximate breakdowns and
are not added again to the provider-reported total.

The tool inventory separates the active set from observed model declarations,
nested callability, hidden declarations/unreachable tools, exposure, and namespace.
Native codemode `on` keeps direct declarations; `only` can hide them while they
remain active and callable. Inactive `codemode`/`deferred` tools remain callable;
`model-only` tools never are. These distinctions appear in the TUI details view
and in both the text and `toolInventory` of non-TUI reports.

Pi has no public effective-loadout getter. Declarations and their rough token
breakdown come from the last observed conventional OpenAI/Anthropic-style
`before_provider_request` tool list, including rewritten descriptions and schemas,
not raw registry descriptions. Before a request, after observable loadout/model/
settings changes, or for unsupported payloads, declarations and tool tokens are
`?`. Reports label this as a last-request observation, not a guarantee about a
future request: later request handlers or stateful loadout hooks can still change
what is sent. System/tool/conversation attribution is rough and non-additive;
provider window usage remains authoritative even if rough estimates exceed it.

Session totals include assistant, nested tool, compaction, and branch-summary
usage across the complete session, matching Pi's billed-session semantics.

## Skill tracking

The extension records model-visible skill content in hidden
`context:skill_loaded` entries:

- a successful direct `read` of the exact skill entry file records the text
  retained in its finalized transcript result only after bounded local file
  evidence verifies the requested `offset`/`limit` source prefix. Genuine prefixes
  and partial-read continuation-notice removal are supported. A selected native
  line over 51,200 bytes has no file output and is not a load; unrelated successful
  redactions are excluded even when their handler runs before this extension.
  Failed, empty and notice-only final output is excluded. Tokens use retained
  finalized text without native continuation notices;
- a nested read is not itself visible: it counts only when it returned the
  complete current entry file, its own `tool_execution_end` confirms finalized
  success with that complete text, and its own caller's successful finalized
  transcript result contains it. A later `tool_result` error rewrite prevents a
  load even when native codemode catches the error and prints its complete text.
  Native codemode `text(await tools.read(...))` is supported. Discarded, partial,
  failed, permission-blocked, redacted, and unrelated sibling output does not count;
- an expanded `/skill:name` user message records its validated skill block;
- reads of scripts, references, and other files under a skill directory do not
  mark the skill entry as loaded.

Only markers on the active context path are shown. A marker discarded by tree
navigation or compaction no longer contributes active skill tokens.
Pending read evidence is limited to 64 reads and 1,048,576 text characters per
turn. Overflow is discarded conservatively. Evidence is released at turn/session/
tree/compaction boundaries; a fresh runtime reconstructs loads only from active
session markers. Filesystem verification uses a fixed buffer capped at 1 MiB plus
one overflow byte, opens nonblocking before its handle-based regular-file check,
rejects non-files and oversized files, and closes its handle.
Direct source ranges require positive integer offsets/limits. Deep nesting,
encoded/reformatted output, changed/oversized files or a backend whose text cannot
be proved against the requested local file range remain conservatively unmarked.

## Installation

Run `mise push context`. The package is installed as the directory
`<PI_CODING_AGENT_DIR>/extensions/context/`; it has no npm runtime dependencies.

## Verification

From the repository root:

```sh
npm --prefix packages/extensions/context test
npm --prefix packages/extensions/context run typecheck
```

`test:unit` and `test:e2e` run the focused suites separately. Both test files are
also discovered by the repository's normal `npm test` Node runner. Root `tsc`
uses a lightweight Pi stub; the unit typecheck separately checks `context.ts`
against the actual host's complete declarations without installing dependencies.
The source contains a narrow assertion for the optional `exposure`/`namespace`
fields omitted by that root stub, not a runtime compatibility branch.

E2E and unit typecheck are verified against actual Pi **0.99.1 and 0.99.2**;
only these two releases are accepted. Discovery checks a locally
resolvable SDK and then the real `pi` executable (including Homebrew's wrapper).
For CI or another layout, set `PI_CONTEXT_TEST_HOST` to the installed
`@earendil-works/pi-coding-agent` package directory. Explicit overrides are
exclusive: empty, missing, malformed, wrong-package, incomplete or unsupported
hosts fail without falling back. E2E asserts the loaded SDK's `VERSION` matches
the selected package metadata; tests never silently skip or install a replacement.

E2E loads this extension with Pi's `DefaultResourceLoader`, creates SDK sessions,
and uses native `createCodemodeExtension`, QuickJS, built-in reads, and real
permission/tool/message dispatch. Only model HTTP responses are deterministic
fixtures on an owner-local server. It checks actual session entries and `/context`
reports for direct/full/discarded/partial/limited/failed/blocked/redacted reads,
finalized failed nested reads with successful catching parents, direct retained
prefixes (including late message rewrites), removed continuation notices and
retained-text token accounting, no-content overlong-line diagnostics, redactors
registered before context, and positive partial/offset source evidence,
physical FIFO replacement after a successful native read (in a deadline-bounded
child process with parent-owned cleanup, preserving retained text without a marker),
overlapping codemode siblings, expanded skill commands, tree navigation,
fresh-runtime reconstruction, compaction-aware markers, inventory in `on`/`only`,
rewritten declaration estimates, authoritative window usage and accumulated totals.
The compaction-boundary fixture uses the public session manager; it does not test
model-generated compaction. Agent/workspace storage is owner-only temporary data;
no live provider, user credentials, installation, or profile writes are needed.
E2E binds `PI_PACKAGE_DIR` to the selected SDK before import so inherited launcher
metadata/assets cannot select a different release. Temporary storage is removed
and test environment overrides are restored on exit.
