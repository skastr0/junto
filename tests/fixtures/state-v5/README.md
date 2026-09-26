# Pre-retirement operator-flags fixture

`flags-v5.db` is a schema-v5 Command Center database whose `factory` canvas
was authored while operator flags were legal. It is the evidence for the
canvas-document migration that retires them
(`src/main/junto/canvas/retire-flags.ts`, run from the canvases bootstrap).

| stored | after the migration |
|---|---|
| `agent` with `flags: ["blocker"]` and the mirrored crimson `color: "1"` | flags and color dropped |
| `peer` with `flags: ["attention", "parked"]` | flags dropped |
| `tasks` sink with `flags: ["parked"]` | flags dropped |
| `gauge` watcher with `watch.flagOnUnsatisfied: true` | that key dropped, the rest of the watch kept |
| `note` with an authored red `color: "1"` and no flags | unchanged |
| `relay-flags` relay -> agent, `cron-flags` cron -> tasks (`flags` verb) | dropped |
| `pad-announces` pad -> relay | dropped |
| `agent-announces`, `task-announces`, `relay-wakes`, `claim-edge` | unchanged |

One task was created through WorkService, so `work_events` holds rows the
migration must leave byte for byte. Portfolio generation 2 before, 3 after.
`tests/canvas-retire-flags.test.ts` pins the file's SHA-256 and copies it to a
disposable directory before any runtime touches it.

`generate.ts` is a manual audit recipe, never imported by the suite. It only
runs on a tree where flags are still in the grammar (the commit before their
retirement); its header shows how to invoke it.
