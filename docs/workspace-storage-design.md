# Workspace storage

Design sent to canvas-lead before migration implementation, 2026-10-07.
Implemented against the shared Effect schemas owned by canvas-lead.

## Authority

The existing StateEngine and its SqlClient own every table. No renderer, CLI,
or helper opens product state. A workspace scope retains the existing name and
opaque id so Work references remain valid; it owns no serialized document,
document revision, mailbox, or aggregate checksum.

Each spatial kind owns its geometry, title, colour, order and domain fields in
its own STRICT SQLite table. There is no shared generic node payload table.

| Kind | Domain columns beyond identity and geometry |
| --- | --- |
| Seat | Binding id, agent key, host, harness, session id, terminal label, overseer, launch kind/cwd/argv/env/extra arguments |
| Terminal | Binding id, host, label, deletion policy, launch fields |
| Region | Hold, instruction, page defaults, host paths, rules, rulings, environment sources and folders |
| Page | URL, browser profile, host, deletion policy |
| Task board | Name, contract |
| Requests | Name |
| Artifacts, board, pad | Identity and geometry; material contents remain in Work |
| Sheet | Label; grid columns and rows in a separate `sheet_grids` table |
| Cron | Optional expression, host |
| Relay | Host; predicates and actions remain derived from wires |
| Watcher | Key, statistic, comparison, threshold, host |
| Note, label | Body or label text |
| Git | Working directory |
| Wire | Semantic source and target ids, verb, attachment sides, attenuation mask |

Structured values use codecs for their exact domain shape in purpose-named
columns. They never form a catch-all object. Mail and all other Work material
are never copied into these rows or returned with spatial lists.

## Commands and changes

Services expose reads by scope, kind and id, plus bounded commands to create,
edit, move and delete individual objects. A transaction changes the addressed
row and publishes one event identifying the scope, kind, id and operation after
commit. A failed transaction emits nothing. Caller-owned outer transactions
defer publication until their commit too. Traced Effect functions identify the
operation and addressed object.

Wire creation validates both endpoints and the domain grammar. Identity is
unique across kinds within a scope. Deleting an endpoint removes its connecting
wires in the same transaction. A command never rebuilds another scope or reads
Work mail.

## Migration proof

Append an atomic 12 → 13 consolidation step after the app-text migration. Copy existing
authority rows into the kind tables, verify replacement counts and identities,
replace the Work authorial-basis trigger's document dependency, then drop the
old node, edge, document and entity tables in that same atomic step. Historical
migration constants remain immutable.

A coherent SQLite backup of the installed database was made through a read-only
connection. It contains 153 factory objects: 84 seats, 44 regions, five terminals,
17 notes, and one page, task board and artifact sink. It has 179 wires. Its 578
archived registry entries lack geometry and executable descriptors and are
retired by the operator's explicit decision. Historical Work facts become
`historical`, with basis columns cleared. Their original event hashes remain
unchanged provenance and those facts cannot be reverified or exported. Every
other durable row stays unchanged. The disposable copy passes integrity and
foreign-key checks, and its schema matches a fresh installation. The live
database is never migrated by a proof script.

The temporary CanvasesService facade builds documents from model rows for
callers still moving to the model API. Writes compare those domain rows and
issue commands in one transaction. The facade and converters leave with the
last document caller; storage has only the per-kind authority from v13 onward.
