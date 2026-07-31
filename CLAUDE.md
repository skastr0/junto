# CLAUDE.md

Read `AGENTS.md` — it is the canonical project guide for this repository.

## Product brand — hard invariant

**The product is Vellum Command. Never bare "Vellum Command".**

Another product is named Vellum Command. Every public / user-facing string in this
repo must say **Vellum Command**. Code identifiers and paths (`VellumApi`,
`~/.vellum/`, `vellum.db`, CLI bin `vellum`) are not brand — leave them.

Gate: `bun run lint:product-name` (also in `bun run verify`).
Constant: `src/shared/product-name.ts`.

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
