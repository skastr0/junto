# Frozen state schema v1 fixtures

These databases are immutable compatibility evidence for Vellum Command's released
SQLite schema version 1. Tests must open them read-only, copy them to a
disposable directory, and migrate only the copy.

| fixture | role-valid representative state | SHA-256 |
|---|---|---|
| `command-center-v1.db` | authored `factory` canvas generation/head, Command Center configuration, enrolled fleet target, claimed CC-home task facts, and peer ACK cursor | `e1c12bcf3a662f52854936bfee1c0ef5fd41e024e80d7223bd3c90e0a1d00d2c` |
| `remote-v1.db` | Remote pairing/configuration, complete installed `factory` projection with a `studio`-homed timer, accepted cross-home task claim command/fact/disposition, receive and peer ACK cursors, and interval scheduler cursor/firing | `23db672fe4f4fbc7fbe0fe4a5c9efd3f009f93f4500462aa036b9aa57ac19cc9` |

Both fixtures were compiled from the exported `STATE_SCHEMA_V1_SQL`, carry
`PRAGMA user_version = 1`, and record the frozen
`STATE_SCHEMA_V1_IDENTITY`. `generate.ts` is a manual audit recipe and refuses
to overwrite either artifact; it is never part of the test path.
