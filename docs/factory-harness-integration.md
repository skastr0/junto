# Factory harness integration — retired proposal

**Status:** retired decision record

**Superseded by:**

- [Managed terminal plan](managed-terminal-plan.md)
- [Factory physics](architecture-factory-physics.md)
- [Vellum Command protocol](vellum-protocol.md)
- [Security doctrine](security-doctrine.md)

This path is retained so older research notes have a stable target. It is not a
second architecture and must not be used as implementation guidance.

## What was retired

An earlier proposal split harness integration into tiers:

- a Vellum Command-local, process-bound actor;
- a plugin without a local Vellum Command installation that called a network-reachable
  work endpoint using a bearer credential;
- ACP or headless workers as the primary autonomous runtime.

That proposal created two work-admission paths and blurred the difference
between fleet synchronization and agent tools. The bearer-credential path,
remote work endpoint, tier policy, plugin install plane, and factory coupling
to ACP were deleted in the factory consolidation.

They do not survive as dormant release flags, future scaffolding, or a fallback.

## Current contract

Vellum Command has one v1 actor runtime and one agent work path:

1. The operator authors an `agent` node with a managed-terminal template.
2. Vellum Command spawns and owns the terminal process on its placed installation.
3. The process tree is bound to the compiled `ActorSeatId`.
4. The descendant CLI reaches the owner-local work control socket.
5. Main resolves the peer process, current projection, edge, port, and sink
   before calling `WorkService`.

Environment variables may provide context, but never identity or authority.
A raw OS terminal, external harness process, or plugin without a local Vellum Command
runtime has no Vellum Command seat and no remote work-control route.

The Station API is separate. Its closed operations synchronize Command Center
intent and single-home work facts with an enrolled Remote, including typed
`overseer` on an existing Command Center-opened session. It is not an agent
tool endpoint, not an RPC tunnel, and does not mint agent authority.

## Decisions that remain useful

The original exploration established several durable ideas:

- the factory owns only sessions it created;
- operator-driven or raw terminals are not silently treated as autonomous
  workers;
- one actor may hold at most one active task;
- process-bind is identity, while injected environment is context;
- actor occupancy comes from the owned terminal lifecycle and observation
  plane;
- harness-specific launch and observation remain plastic vendor glue around
  pristine seat, capability, and work contracts.

Those decisions are incorporated in the current documents linked above.
