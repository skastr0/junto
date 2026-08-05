# Factory simulator prototype

This is an opt-in experiment. It is not imported by the application and is not
part of `bun run verify`.

Run it with:

```bash
bunx vitest run experiments/factory-simulator/factory-simulator.test.ts
```

It proves two seams:

1. A generated conformance matrix enumerates every current public Vellum Command CLI
   command and exhausts target-scoped commands across source kind, edge
   direction, edge mask, and target kind.
2. A deterministic scenario runs real SQLite repositories, canvas projection,
   task claiming, managed-terminal prompt writes, a turn-start hook, and the
   source Vellum Command CLI as a real child process over the work control
   socket and CLI input schemas across four logical ticks.

The fake boundary is the external agent and PTY. The scenario records raw PTY
writes, hooks, CLI calls/results, claim delivery, and a state snapshot after
every tick.

Version-one limits are intentional: one process-bound actor per scenario, no
Electron renderer, and no browser-plane commands. Those are separate seams;
this prototype exists to test whether the data-driven simulation shape is
useful before it is consolidated into a permanent harness.
