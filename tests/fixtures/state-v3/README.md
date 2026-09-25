# Pre-retirement `escalates` fixture

`escalates-v3.db` is a schema-v3 Command Center database whose `factory`
canvas was authored while agent -> requests `escalates` was a legal edge verb.
It is the evidence for the canvas-document migration that retires that verb
(`src/main/junto/canvas/retire-escalates.ts`, run from the canvases bootstrap).

| edge | stored ether | after the migration |
|---|---|---|
| `claim-edge` agent -> tasks | `{"verb":"works"}` | unchanged |
| `raise` agent -> requests | `{"verb":"escalates"}` | dropped |
| `raise-masked` peer -> requests-2 | `{"verb":"escalates","mask":["request.escalate","msg.list"]}` | dropped |
| `mail` agent -> peer | `{"verb":"messages","mask":["msg.send","request.escalate"]}` | mask narrowed to `["msg.send"]` |

Portfolio generation 2 before, 3 after. `tests/canvas-retire-escalates.test.ts`
pins the file's SHA-256 and copies it to a disposable directory before any
runtime touches it.

`generate.ts` is a manual audit recipe, never imported by the suite. It only
runs on a tree where `escalates` is still in the verb grammar (the commit
before the verb was retired); its header shows how to invoke it.
