# soul

Pi 1.0 extension that adds `## Avoid Overengineering` and four test-policy
bullets for these exact model IDs:

- `gpt-6-astra`
- `gpt-6.1-sol`
- `gpt-6-luna`

The policy lives in [`soul.ts`](./soul.ts). All other models receive no Soul
policy, with or without global instructions. No instruction file is written
on disk.

- **Global AGENTS loaded:** the policy is appended to the **in-memory global
  AGENTS content**, following the existing global instructions and before
  parent-directory and project instructions. Existing text, paths, and Pi's
  XML wrappers are preserved; no extra wrapper is added and no `systemPrompt`
  override is returned.
- **No global AGENTS loaded:** Soul returns `event.systemPrompt` followed by
  the policy as the per-run `systemPrompt`. Role and manager prompt text is
  preserved, and project contexts are not modified.

## Behavior

- Uses Pi's `getAgentDir()` to locate the global context file, including
  `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` alternatives.
  If none is loaded, Soul uses the system-prompt fallback above; project
  instructions are never used as a substitute.
- Applies once at `before_agent_start`, using Pi's fresh copies of the loaded
  context records and system prompt for that agent run. This does not reread
  AGENTS from disk.
  Tool follow-up requests retain the policy without appending it again.
  Repeated runs do not accumulate it; model selection is reevaluated at the
  next agent run, not mid-tool-loop.
- Pi records structured prompt changes in the session transcript; unchanged
  sections do not produce another identical prompt update. Another extension
  forcing a complete `systemPrompt` can mask this addition.
- Matches the selected `ctx.model`, not a virtual router's physical target.
  SDK embedders must align their `agentDir` with `getAgentDir()`.

## Verification

```sh
node --import tsx --test packages/extensions/soul/soul.test.ts
```

Unit tests cover model selection, the global-context path, the system-prompt
fallback, and per-run non-accumulation. Repeated runs,
resume, and model switching should be checked through the actual Pi CLI rather
than by reusing one synthetic event object.
