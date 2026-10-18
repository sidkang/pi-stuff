# Apply Patch

Apply Patch owns Pi's public `apply_patch` tool and its GPT/o-series/Codex visibility gate.

## Workspace Language

**Workspace Authority**:
The once-per-execute decision of which adapter owns workspace I/O (Host or Sandbox) and the admitted workspace root for that placement, including fail-closed Workspace Access v2/v1 rules.
_Avoid_: Workspace resolver, access probe, placement helper

**Workspace-backed File Workflow**:
A tool-specific file execution path selected from a resolved Workspace Authority so callers do not re-decide placement or reimplement Host/Sandbox branching.
_Avoid_: Dual host/sandbox helpers, placement switch

## Presentation Language

**Presentation Lifecycle**:
The once-per-execution ownership of which presentation adapter renders a tool call and its terminal result (Better TUI Protocol v1 or native fallback), including sticky family selection, safe discovery failure, and terminal result attempt rules, while the tool keeps domain-specific semantic presentations and native preview/timer/path behavior.
_Avoid_: Better TUI bridge, renderer helper, presentation fallback chain
