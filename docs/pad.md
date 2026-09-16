# Junto pad

Operator and wired agents share one page. The operator marks. The agent
sees the same page (SVG + digest + look-here crop) and patches named
boxes and pins. Ordinary agents never write the crew canvas. An overseer
authors canvas through closed `overseer` commands, not through pad.

Contract: [`pad-architecture.md`](pad-architecture.md).
CLI discovery: `junto docs node pad`.

## Operator

Focus the pad card (double-click or RTS **Open pad**). One SVG. Every write
is a `PadPatch`. Theme is the dim command room, not a crayon whiteboard.

### Tools

| key | tool |
|---|---|
| `v` | select, move, resize (4 AABB handles) |
| `r` | box |
| `o` | ellipse |
| `t` | triangle |
| `l` | label |
| drag from a side | edge |
| `p` | pin — click places, drag sets look-here bounds |
| `i` | image — content store → `ContentRef` (also paste or drop) |
| `d` | ink — record points, upsert on pointer up |
| `[` `]` | z inside the layer |
| delete | delete the selection |
| `⌘z` | local inverse patch — durable with the next editor write |
| space + drag / middle mouse | pan |
| wheel | zoom |

Undo changes the local view immediately. Pending inverse patches become
durable with the next successful editor write; closing before that write
discards them. External pad changes clear local undo history. Deleting a
pin that has replies is not undoable — the confirm-free delete removes
the thread for good. Typing targets (label input, pin reply) and focused
controls own their keys; only `Esc` joins the editor cancel chain.

Empty pad: mark the page. `R` box, `P` pin, `I` image, `D` ink.

### Pins and @

A pin is a comment site, not a shape. Drag while placing to set
`bounds` (the look-here crop). The pin thread is inbound wired actors
only. `@` cannot name an unwired agent.

### Images

Bytes never live in pad JSON. The operator picks, pastes, or drops an
image. Junto stores a `ContentRef`. Agents may not upsert
images.

### Ink

Human overlay. Points are recorded at 1–2px spacing and committed as one
ink element. Agents may not upsert ink. No pressure, no pixel eraser.

## Agent

Working copy is `pad.read`, not the crew digest. Process-bind + an
edge that grants the port. No edge is `ScopeError`.

### Ports

Only two work ports exist:

| port | grant | result |
|---|---|---|
| `pad.read` | read the connected pad | `{ revision, pad, digest, svg }`. Optional `pinId` adds `lookHere { bounds, digest, svg }`. |
| `pad.patch` | apply `PadPatch[]` | `{ revision, pad, digest }` |

CLI projections of `pad.read` (same grant):

```
junto pad read '{"target":"<pad-id>"}'
junto pad digest '{"target":"<pad-id>"}'
junto pad svg '{"target":"<pad-id>"}'
junto pad get '{"target":"<pad-id>","id":"<element-id>"}'
junto pad look-here '{"target":"<pad-id>","pinId":"<pin-id>"}'
junto pad tagged '{"target":"<pad-id>"}'
```

Mutation:

```
junto pad patch '{"target":"<pad-id>","patches":[{"op":"upsert","layer":"shape","shape":{"id":"box-1","type":"box","x":0,"y":0,"w":80,"h":40,"z":0}}]}'
```

Agents may upsert shapes, edges, and pin posts. Discover schemas with
`junto schema show pad.read` and `junto schema show pad.patch`.

### Refusals

Refuse, do not ignore:

- `agents cannot upsert ink`
- `agents cannot upsert images`
- `mention "<id>" is not an inbound actor on this pad`
- `ScopeError` without an inbound edge that grants the port

Mentions on `pin.upsert` must be inbound actor node ids. `@` cannot name
an unwired agent. `pin.reply` authors are stamped by WorkService.

### look-here

`pad.read` with `pinId`, or `junto pad look-here`. Crop is
`pin.bounds` when present, otherwise the pin ± margin. Use it when the
operator pointed at a region. A pinId that no longer resolves degrades a
`pad.read` to a plain read (`lookHere` omitted, nothing marked read);
`junto pad look-here` stays strict and fails on the same input.

### tagged

`junto pad tagged` lists pins that mention this process-bound
seat. Same `pad.read` grant. The mention universe is inbound actor
edges; unwired names are refused on `pad.patch`.
