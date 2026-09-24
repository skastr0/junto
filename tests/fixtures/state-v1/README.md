# State schema v1 baseline fixtures

These databases are the pinned baseline evidence for Junto's SQLite schema
version 1 — the current durable shape after the product rename re-baselined
the schema at that composition. Tests open them read-only and copy them to a
disposable directory before any runtime touch.

| fixture | role-valid representative state | SHA-256 |
|---|---|---|
| `command-center-v1.db` | authored `factory` canvas (relational authority rows + portfolio head), Command Center configuration, enrolled fleet target, claimed CC-home task facts, and peer ACK cursor | `ba3fd2b90591bd83f3706b153799c0f325ab47bc10b273be5fdcccd9155a2615` |
| `remote-v1.db` | Remote pairing/configuration, complete installed `factory` projection with a `studio`-homed timer, accepted cross-home task claim command/fact/disposition, receive and peer ACK cursors, and interval scheduler cursor/firing | `2d9e0be7c9571292ad872e45b415efa8fbdfa91198ab0a178f1ae31d12c6588a` |

Both fixtures were compiled from `STATE_SCHEMA_V1_SQL` in `schema.ts` here, carry
`PRAGMA user_version = 1`, and record `STATE_SCHEMA_V1_IDENTITY`.
`generate.ts` is a manual audit recipe — re-run it after an intentional
baseline change; it overwrites both artifacts and is never part of the test
path.
