# Node kind: artifacts

**Role:** sink

The delivery surface: create and edit outputs with junto artifact; artifacts never block.

## Ports offered
- (none: reach admits; a seat with this node in its reach holds every command below)

## Data model
_Artifacts node: links, documents, pads, sheets and files, each versioned; every write is ruled by the machine that edits the canvas._

- `kind`: string
- `id`: string
- `x`: number
- `y`: number
- `width`: number
- `height`: number
- `z`: integer
- `color`: string
- `label`: string

## Events
- artifact.create, artifact.edit — versioned, ruled by the machine that edits the canvas
- artifact.label — the whole label set, or labels added and removed; the version stays
- artifact.colour — a label's colour in the node, one of eight names or none
- artifact.comment — a thread on the artifact, whole or at an anchor

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

A seat with this node in its reach holds all of these.
```
### Contract — artifacts (target `<artifacts-node-id>`)

| intent | command |
|---|---|
| what is here | `junto artifact list --node <artifacts-node-id>` |
| ship output | `junto artifact create "<title>" --type document --node <artifacts-node-id> --markdown "..."` — --task <taskId> links it to a task; link, pad, sheet and file are the other types |
| read, then edit | `junto artifact show <id>, junto artifact edit <id> --base <n> --markdown "..."` |

Artifacts never block: ship intermediate and final outputs freely — they do not stop other seats. Every Artifacts node in your reach admits you, with no edge. An edit names the version it was written against with `--base`; a stale one is refused with the head, so read it again and redo the edit. For a task that wants an artifact, create it with `--task <taskId>`, then cite it on `junto task finish #<n> --artifact <node id>/<artifactId>`.
```