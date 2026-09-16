# CLAUDE.md

Read `AGENTS.md` — it is the canonical project guide for this repository.

## Product name: Junto

**The product name is Junto.**

Every public, user-facing, and runtime string in this repo uses the name **Junto**. Runtime surfaces use `JuntoApi`, `~/.junto/`, `junto.db`, and the canonical CLI bin `junto`. Source paths live under `src/main/junto/`.

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

## Overseers

Read `AGENTS.md` and `docs/security-doctrine.md`. Ordinary agents never write
the canvas. A human-toggled overseer on an existing managed agent seat is the
narrow exception: closed `overseer` commands, no edges required, Command Center
authors, pause/play do not apply, no self-delete, no viewport move, no
propagation, no operator socket.
