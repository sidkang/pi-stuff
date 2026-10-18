---
metadata:
  upstream:
    repo: vanillagreencom/vstack
    path: pi-extensions/pi-codex-minimal-tools
    commit: dcd27efa2cbf793f840c4e15cabfd09c5195388d
    status: modified
    notes:
      - local: standalone apply_patch delivery unit extracted from Codex Tools; no runtime import of Codex Tools or Sandbox
      - local: execute the parser/applier in process with transactional rollback, cancellation, and fail-closed Workspace Access v2
      - local: keep GPT/o-series/Codex visibility gating and Better TUI Protocol v1 plus native fallback
      - local: expose schema-defined structured result metadata without source diff/patch or Host-only absolute paths
      - local: model-facing description and context guidance also adapt openai/codex apply_patch tool instructions (openai/codex commit 0d78fa8846b449558b7906dc052982fd71ecff97); that instruction source is separate from this unit's vanillagreencom/vstack marker
---

# apply-patch

In-process `apply_patch` for Pi. This bundle is the sole owner of that public
tool and its GPT/o-series/Codex visibility gate. Codex Tools no longer
registers, gates, or documents `apply_patch`.

This unit has no settings and no compatibility shim. It loads without
Codex Tools or Sandbox.

## Installation

Install or update this delivery unit only through the repository command. After
extracting `apply_patch` from Codex Tools, update both units in this order:

```sh
mise push apply-patch codex-tools
```

The bundle has a locked runtime dependency and is installed with the standard
bundle `npm ci --omit=dev` step. Do not install the repository path directly.

## Sandbox composition and trust boundary

Apply Patch is Host-capable on its own. It loads and runs without Sandbox, does
not import Sandbox, and does not require any Sandbox event or compatibility shim.

When Sandbox is present, each `apply_patch` execute resolves Workspace Access
**v2** (`sandbox:workspace-access:query:v2`) once:

- v2 `access` → workspace effects go through the structural Sandbox adapter only
  (`inspect` / `writeFile` / `remove`); no Host filesystem fallback
- v2 `host` or no listener → Apply Patch uses its own Host adapter (standalone behavior)
- v2 `unavailable` → hard error
- if only older v1 answers: Host placement still authorizes Host behavior;
  sandbox placement or unavailable requires v2 (`Sandbox Workspace Access v2 is required`)

Parser, planner, and renderer stay Host-owned. There is no settings block.

Internal gate and presentation identity strings remain the historical
`sid.pi.codex-tools.apply-patch-gate-states` and `codexToolsBetterTuiV1` keys so
reload and in-session state stay compatible after the extraction.

## `apply_patch`

`apply_patch` is available as a Pi tool on GPT/OpenAI/Codex-like models. It applies the Codex patch envelope in process and supports grouped add, update, delete, and move actions with transactional rollback:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-old line
+new line
*** Add File: src/new-file.ts
+export const value = 1;
*** End Patch
```

Use literal relative paths rooted at the current working directory—do not quote them or prefix them with `@`—and prefix every added line with `+`. As in Codex's native guidance, include 3 complete lines immediately above and below each change by default. If that context is not unique, put the enclosing class, function, method, test, or other unique section after `@@`; consecutive `@@` section headers can navigate nested context. Use `read` first when current context may have changed. Paths are protected against traversal and symlink escapes. Pi's native `read`, `edit`, and `write` tools remain available.

### Structured results

`apply_patch` declares an `outputSchema` and returns `structuredContent` with
`ok`, `summary`, `changedFiles`, relative `files` action metadata, `noops`, and
an optional `firstChangedLine`. Native Pi codemode callers receive that object
instead of parsing the display summary. Moves retain `moveTo`; all-no-op
patches return `ok: true` with empty `changedFiles` and recorded no-op metadata.
Full diff/patch source and Host-only absolute paths remain in renderer details,
not structured results. Text output, visibility gating, rollback, Workspace
Authority, and thrown failures are unchanged.

The metadata is additive on older hosts; native codemode consumption and actual
host declarations are tested against Pi 0.99.1 and 0.99.2 without changing this
unit's existing development SDK baseline. File mutations declare destructive,
non-read-only, non-idempotent, workspace-local annotation hints. These hints do
not replace permission checks or change the default direct exposure.

### Validation

`npm test` runs all unit tests and the real Pi session/native-codemode E2E.
`npm run typecheck` checks the development SDK and then the real host declarations;
`npm run typecheck:host` runs only the host declaration gate. Existing root test
and typecheck commands invoke these package gates.

Host discovery prefers the current tested 0.99.2 installation. To run the exact
original 0.99.1 regression, set `PI_APPLY_PATCH_HOST` to that authentic unpacked
SDK directory. Only these two tested releases are accepted. Explicit overrides
fail closed, and loaded SDK `VERSION` must match its package metadata. An inherited
`PI_PACKAGE_DIR` pointing at another release causes a mismatch; unset it rather
than bypassing the assertion:

```sh
env -u PI_PACKAGE_DIR -u PI_SKIP_VERSION_CHECK PI_APPLY_PATCH_HOST=/path/to/pi-sdk npm test
env -u PI_PACKAGE_DIR -u PI_SKIP_VERSION_CHECK PI_APPLY_PATCH_HOST=/path/to/pi-sdk npm run typecheck:host
```

E2E loads `index.ts` through `DefaultResourceLoader` and uses a real agent session,
`createCodemodeExtension`, QuickJS, nested tool dispatch, and permission events.
Only the model provider is scripted; no paid services or credentials are needed.
Its agent directory and workspace are owner-only temporary directories. It covers
structured add/update/move/delete/mixed/all-noop results, direct exposure,
`parentToolCallId`, denial, inactive/wrong-model calls, malformed/path/symlink
errors, Workspace Authority fail-closed behavior, cancellation, rollback/conflicts,
and same-file concurrency. Setup failures fail the gate instead of skipping.

Injected workspace-adapter failure/rollback cases are unit evidence only. Native
rollback tests use the unmodified selected Host workflow: a regular-file ancestor
blocks a later add after two actual writes. An existing-file watcher observes the
second mutation and verifies the first write's bytes; the conflict case then writes
foreign bytes as a real competing filesystem actor. The tests assert actual
rollback versus a confirmed written-state conflict, preservation of foreign and
protected bytes, and an error without success-shaped output. No adapter, parser,
queue, tool, session, QuickJS or nested-dispatch implementation is substituted.
Watchers have a fixed cleanup deadline; no sleeps, timing-based retries or
manufactured workspace-operation errors are used in native failure evidence.

### Rendering and Better TUI

Two intentional rendering paths, without changing Protocol or product semantics:

- **Native fallback** still provides an async read-only call preview (Host filesystem when allowed).
- **Better TUI / Compact Blocks** do not start owner-local Host preview I/O: the block coordinator owns the call/result slots, so Apply Patch returns that slot as-is. Unified diffs appear in the **expanded** Protocol v1 result body, not as a collapsed call-time host preview wrap.

The tool is activated for GPT, o-series, and Codex model IDs, including provider-qualified IDs such as `openai/gpt-4.1`; `openai-codex` providers are also recognized. On other models it is removed from Pi's active tool list while unrelated tools remain unchanged. Availability is not extended to non-GPT models. Pi has no public tool-unregister API, so the registered definition remains discoverable through configuration UIs but is hidden from the model prompt and blocked defensively if called.

The visibility gate saves `apply_patch`'s active-list position when hiding it and
restores it at that position when returning to a supported model, rather than
appending it. Repeated model switches and extension reloads retain that saved
position; unrelated tools keep their current relative order, and an explicit
disablement is still respected. If the list shrinks while gated, the saved
position is clamped to its end. Older in-process gate states without a saved
position retain the previous append fallback; restart Pi to begin with fresh
state after updating. This avoids order-only prompt changes, not cache misses
caused by model/tool-set changes or other prompt changes.

Application details:

- all touched paths enter Pi's per-file mutation queues in deterministic order;
- update hunks are applied in patch order with a per-action logical-line cursor; a bare `@@` hunk searches at or after that cursor using exact, ignored-trailing-whitespace, then ignored-surrounding-whitespace tiers, requires one unique match in the first tier that has any matches, and advances the cursor to immediately after the replacement;
- `@@ section` preserves the section text, uses the same ordered whitespace tiers to require one unique section match at or after the cursor, and starts that hunk's search strictly after the section line; consecutive section-only `@@` hunks advance through nested class/function context without writing, while a section plus-only hunk inserts immediately after its section anchor;
- `*** End of File` is accepted only after a non-empty update hunk, applies the end-of-file constraint independently within each whitespace tier, anchors that hunk's old block to the logical end of the current virtual file, and ends that update action's body; an EOF plus-only hunk appends;
- section and EOF anchors narrow repeated-block matches without adopting Codex's Unicode-punctuation normalization or first-match behavior; missing sections, non-EOF matches, backwards matches, and ambiguous permitted matches fail before mutation;
- an update hunk is a successful `already_satisfied` no-op only when its uniquely matched source lines already equal the materialized replacement; explicit `-`/`+` lines can therefore change whitespace after a tolerant match, while untouched context retains source whitespace; a no-op advances the cursor without writing and records bounded line metadata;
- updates preserve the file's LF or CRLF line endings;
- Add File accepts only `+` content lines without `@@` headers and creates a final LF newline; add refuses an existing target, delete refuses a missing target, and move refuses an existing destination;
- `*** Move to:` is accepted only immediately after its Update File header and before all hunks; deleting and then adding the same path is committed as a real replacement rather than an in-place update;
- failures and cancellation roll back confirmed operation-written states, including original file modes and newly created empty parent directories; external or indeterminate states are left untouched and reported as rollback conflicts;
- successful results retain Pi diff, unified patch, changed-file, first-changed-line, and `already_satisfied` no-op details for TUI rendering and session inspection; an all-no-op patch returns success with no changed files and an empty diff/patch;
- ambiguous update failures include bounded, line-numbered windows from the current virtual file state and repeat Codex's 3-line and `@@` section guidance; insertion hunks anchored only by repeated closing lines such as `}` or `});` receive a specific retry diagnostic; excess candidates are explicitly omitted.
- delete actions are header-only, and the GNU diff `\\ No newline at end of file` marker is rejected rather than applied ambiguously.

### Supported text and concurrency constraints

- Existing files must be valid UTF-8 and have exactly one hard link. Invalid byte sequences and multiply linked files are rejected before planning or mutation; bytes are never decoded with replacement characters. A leading UTF-8 BOM is preserved byte-for-byte while excluded from logical-line matching.
- Existing files may use uniform LF or uniform CRLF line endings. Mixed LF/CRLF files and CR-only line endings are rejected rather than normalized and rewritten.
- Update hunks match explicit complete logical-line sequences, including blank lines. A bare hunk containing only `+` lines retains the local append behavior; when the existing non-empty file lacks a trailing newline, a separator newline is inserted. Section and EOF plus-only hunks use their anchor semantics above. Updates preserve the existing file's trailing-newline state when the resulting file still has logical lines. Add File always terminates its generated LF content with a newline.
- Matching follows Codex's whitespace tiers—exact lines first, then ignored trailing whitespace, then ignored surrounding whitespace—but does not normalize Unicode punctuation or silently choose the first repeated match. Every tier remains constrained by the monotonic cursor/section/EOF scope and requires one unique match. Untouched context lines retain their original whitespace, and `\\ No newline at end of file` is rejected.
- Retry source windows escape terminal control bytes for display only (source matching still uses the original text).
- Absolute paths are rejected by the public tool contract. Relative patch paths are interpreted literally, constrained to the working directory, and rejected if any existing segment is a symlink.
- Apply uses optimistic checks rather than an atomic transaction: immediately before each mutation it rechecks the path's bytes, type, mode, line-ending style, hard-link count, and filesystem identity, and revalidates path symlink segments. These checks detect many external changes, but they are not atomic and cannot defeat adversarial symlink or rename swaps between validation and pathname syscalls; this implementation has no `openat` transaction.
- Rollback restores or removes a path only while it still matches the exact state written by this operation. If another process changes that state, or a mutation's post-state becomes indeterminate, rollback reports a conflict and leaves the external state untouched.
