# CLAUDE.md

Read `AGENTS.md` — it is the canonical project guide for this repository.

## Product brand — hard invariant

**The product is Vellum Command. Never the short form without Command.**

A different product owns the short one-word name. Every public / user-facing
string in this repo must say **Vellum Command**. Source paths (`src/main/vellum/`), the npm package,
and appId remain compatibility identifiers. Runtime surfaces use `VellumCommandApi`,
`~/.vellum-command/`, `vellum.db`, and the canonical CLI bin `vellum-command`.

Gate: `bun run lint:product-name` (also in `bun run verify`).
Constant: `src/shared/product-name.ts`.

## Copy law — hard invariant

**No middle dots (U+00B7) anywhere.** Not in product copy, UI strings, docs, or
artifacts. Use commas, em dashes, or spaces. Wire sentences read as spoken
compounds ("access stops"), never dotted.

## Multi-agent tree (for builders)

At any time, multiple agents are working this codebase concurrently — the
worktree is shared, and unfamiliar uncommitted changes belong to another
agent.

- Never stash, revert, delete, or "clean up" code you did not write. Assume it
  is another agent's in-progress work and leave it alone.
- Commit your own work aggressively: as soon as a change is done and gated,
  stage only your own files and commit immediately. Do not leave your work
  unstaged.
- No conciliation or consolidation passes. Write your code, commit it, move on.
