# State schema v13 fixtures

Version 13 is the oldest database Junto opens. These two databases are the
pinned evidence for it. Tests copy them to a disposable directory before
touching them.

| fixture | holds | SHA-256 |
|---|---|---|
| `command-center-v13.db` | the `factory` canvas, Command Center configuration, an enrolled fleet target, task facts and a peer ACK cursor | `c31b3097c2c2c56130d9b5e3d9fce4dd1bc289e40e58feab2623801cf0e2072d` |
| `remote-v13.db` | Remote pairing and configuration, the installed `factory` canvas with a timer, a task claim command, fact and disposition, receive and peer ACK cursors, and an interval scheduler cursor and firing | `de746b761025302f018311b1dda3c3008ac99179d95560722176eddbb01cf719` |

Both were made once, when the floor rose to 13. The version-1 fixtures were
taken through the real steps 1 -> 13, then vacuumed. Each holds
`PRAGMA user_version = 13` and records `STATE_SCHEMA_V13_IDENTITY`. Those
steps are gone, so the databases cannot be remade. Never regenerate them.

`schema.ts` composes the frozen schema text of versions 13 to 24.
