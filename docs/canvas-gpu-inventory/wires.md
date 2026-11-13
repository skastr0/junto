# Canvas wires and routing: inventory of today's behaviour

Root: the repository root. Every receipt below is relative to it. `RF:` = `node_modules/@xyflow/react/dist/esm/index.js`, `RFS:` = `node_modules/@xyflow/system/dist/esm/index.js`, `RFCSS:` = `node_modules/@xyflow/react/dist/style.css`. Installed: `@xyflow/react` 12.11.2, `@xyflow/system` 0.0.79 (`node_modules/@xyflow/react/package.json:3`, `node_modules/@xyflow/system/package.json:3`). Nothing was edited, built or run beyond read-only reads and greps. Lines marked (inference) or (arithmetic) are mine, not the code's.

## 1. What a wire is

| Field | Type | Meaning | Receipt |
|---|---|---|---|
| `id` | `WireId`, branded string 1 to 256 chars | minted by the window as `edge-<ulid>` | `src/shared/model/wire.ts:10-14, :21`; `src/window/lib/edge-mutations.ts:167` |
| `from` | `NodeId` | "The verb's subject: the end that acts" | `src/shared/model/wire.ts:22-23` |
| `to` | `NodeId` | other end; schema refuses `from === to` | `src/shared/model/wire.ts:24, :32-34` |
| `verb` | one of `messages`, `navigates`, `flows`, `derives` | "the one authored fact on a wire" | `src/shared/model/wire.ts:25`; `src/shared/physics/verbs.ts:25-30`; `AGENTS.md:254` |
| `mask?` | `Port[]` | narrows the grant: only ports listed in `mask` survive | `src/shared/model/wire.ts:26-27, :68-71` |
| `fromSide?`, `toSide?` | `Side` | "Where the line attaches. Absent means the nearest side." | `src/shared/model/wire.ts:28-30` |

| Verb | Ordered pair | Compiled grant | Sentence | Colour token |
|---|---|---|---|---|
| `messages` | agent to agent | ports `msg.list, msg.send, msg.prompt, seat.wait, terminal.read` | "{from} messages {to}" | `--wire-verb-messages` |
| `navigates` | agent to page | port `browser.automate` | "{from} drives {to}" | `--wire-verb-navigates` |
| `flows` | task to task | no ports, `flow: true` | "{from} flows into {to}" | `--wire-verb-flows` |
| `derives` | task to task | no ports, `derive: true` | "{from} derives into {to}" | `--wire-verb-derives` |

Receipts: table `src/shared/physics/verbs.ts:61-75`; compile `:134-154`; ports `:123-125`; tokens `:163-168`; sentences `src/window/lib/verb-sentence.ts:8-13`.

- Rows for `terminal`, `automations`, `files` are empty (`src/shared/physics/verbs.ts:69-74`). A kind with no table side cannot be wired (`:40-45`); `physicsKind` gives none to note, file, link, region (`src/window/lib/model-kind.ts:13-14`). `canConnect` also refuses region, label, git, files and build-disabled kinds (`src/window/lib/edge-mutations.ts:62-69`).
- Draw direction: drawn order if the table admits it, else reversed and stored the other way round (`src/window/lib/edge-mutations.ts:39-56`; `src/window/lib/model-edits.ts:353-355`).
- "Two verbs per ordered pair is the ceiling (tested). Where a pair holds two, a plain connect stamps the first." (`src/shared/physics/verbs.ts:57-58, :102-105`).
- One wire per ordered pair whatever the verb: refusal `duplicate` (`src/window/lib/model-edits.ts:360-362`). Task verbs must stay a DAG: refusal `cycle` (`:374-379`). Full refusal set `:321`.
- Derived, never stored: ports, `flow`, `derive` (`src/shared/physics/verbs.ts:110-121`; `src/shared/model/wire.ts:6-8, :62-72`); phase `blocks` or `relates` (`src/shared/model/wire.ts:38-39`; `AGENTS.md:274`); stoppage (`AGENTS.md:270`); the painted sides (`src/window/lib/flow-edges.ts:38-39, :52-54`); route, lane and strand (section 3).
- Wire edits: `connected` (Add), `reverbed` (Rewire verb, clears mask), `masked`, `reanchored` (`src/window/lib/model-edits.ts:332-381, :404-423`). Only `reverbed` has callers in `src` (`src/window/components/rts/RtsControls.tsx:141`, `src/window/components/rules/BoardTargets.tsx:47`); `masked` and `reanchored` have none outside tests (grep).

## 2. Pipeline, model wire to what React Flow is given

| # | Step | Shape out | Receipt |
|---|---|---|---|
| 1 | `toFlowOfCanvas(canvas, context, execution?, cache?)` | `{nodes, edges}` | `src/window/lib/convert.ts:55-66` |
| 2 | `flowEdgesFromModel(canvas, cache)` over `canvas.wires.values()` | `Edge<ModelEdgeData>`: `{id, source: wire.from, target: wire.to, sourceHandle: "s-<side>", targetHandle: "t-<side>", type: "wire", data: {verb, colorToken, fromKind, toKind}, zIndex: 16}` | `src/window/lib/flow-edges.ts:41-85`, `WIRE_Z = 16` `:13-14` |
| 3 | `stampImpactShell` | adds `selected`, `className` (`impact-edge-in` or none), `data.impact: "in"`; same object when unchanged | `src/window/components/Canvas.tsx:231-270`; `src/window/lib/impact-mode.ts:151-169` |
| 4 | `setEdges` | previous array kept when every edge is identical | `src/window/components/Canvas.tsx:298-302` |
| 5 | `<ReactFlow edges edgeTypes>` with `edgeTypes = { wire: WireEdge }` | all wires are type `wire` | `src/window/components/Canvas.tsx:1829-1831`; `src/window/components/edges/WireEdge.tsx:166-168` |
| 6 | RF `EdgeWrapper` resolves ends from handle bounds | `sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition` | `RF:2927-2954`; `RFS:1379-1411` |
| 7 | `CanvasLoom` plans (renders nothing) | `loomStrands$[id]`, `loomRoutes$[id]`, `loomLanes$[id]` | `src/window/components/edges/CanvasLoom.tsx:549-675`; `src/window/lib/loom-view.ts:44-65` |
| 8 | `WireEdge` picks `stitched?.path ?? plannedRoute?.path ?? fallbackPath` | SVG `d` string | `src/window/components/edges/WireEdge.tsx:79-99` |
| 9 | `BaseEdge` plus portal overlays | SVG paths, track and pulse divs | `src/window/components/edges/WireEdge.tsx:116-161` |

- Sides in step 2: `wireSides(fromRect, toRect)` whenever both ends exist; the stored `fromSide`/`toSide` are used only when an end is missing, then `right`/`left` (`src/window/lib/flow-edges.ts:52-54`). Rect = model x, y plus `renderedNodeSize` (`:33-35`).
- Identity cache: an edge object is reused when `cached.wire === wire` and handles and kinds are unchanged (`src/window/lib/flow-edges.ts:57-69`); vanished ids pruned (`:83`).
- Rebuild triggers: any node or wire of the open canvas (`src/window/components/Canvas.tsx:346-351`), `seatTasks$.bySeat` (`:354-357`), `state$.actorRefs` (`:358`), `kernel$.executionRev` (`:359`), `rebuildTick` after a drag (`:334-336`), region label drag commit (`:367-371`). Deferred while a drag is in progress (`:313-318`).
- Selection restamp only: `selectedNodeId`, `selectedNodeIds`, `selectedEdgeId`, `connectionFocusNodeId` (`src/window/components/Canvas.tsx:376-434`).
- Loom re-run: effect deps `[geometry, specsKey]` (`src/window/components/edges/CanvasLoom.tsx:672`); its memo comparator reads only `id, source, target, sourceHandle, targetHandle`, so selection stamps do not reach it (`:524-547`).
- `WireEdge` re-render: its four keyed observables (`src/window/components/edges/WireEdge.tsx:64-69`) or new props from RF.

## 3. Routing

Three path sources, in precedence order (`src/window/components/edges/WireEdge.tsx:96-99`):

| Source | When | Built by | Ends |
|---|---|---|---|
| Strand (cable member) | 3 or more wires on one handle form a fan | `planLoom` then `stitchStrand` per render | RF live handle points (`src/window/lib/wire-loom.ts:943-947`) |
| Planned route | a card touches the wire's search box | `routeWire` via `planStandaloneRoutes` | node rect side midpoints plus pair lane (`src/window/components/edges/CanvasLoom.tsx:189-201, :332-351`) |
| Fallback elbow | router returned `null` | RF `getSmoothStepPath`, `borderRadius: 8` | RF live handle points plus pair lane (`src/window/components/edges/WireEdge.tsx:83-94`) |

**Sides** (`src/shared/wire-sides.ts:72-106`): all 16 side pairs scored, cheapest wins. Cost = Manhattan length between side midpoints + `WRAP_COST = 600` plus shortfall when the far socket is less than `CLEARANCE = 40` ahead (per end) + corners x `CORNER_COST = 110` (0 corners when facing and within `IN_LINE = 1`, 2 when facing off line or same way, else 1) + `MINOR_AXIS_COST = 4` (`:42-54, :90-98`). Default `right` to `left` (`:77`).

**Standalone router** (`src/shared/wire-route.ts`):
- Inputs: source, target, obstacle rects, `padding`, `borderRadius`, both directions (`:18-31`). Called with `padding: 14, borderRadius: 8`, the wire's own two cards removed from the obstacles (`src/window/lib/loom-view.ts:196-210`).
- Staged clearance: pads `[padding, min(padding,8), min(padding,4), 0]`, deduped; first pad that routes wins (`:242-248, :763-781`).
- Search box: ends' bounding box grown by `corridorPad = max(padding*2, 40)`; only cards touching it are considered; if the found route crosses an unseen card the box grows to hold the route and the search repeats, at most `BOX_GROWTHS = 3` times, the last over every card (`:269, :278-312`).
- Returns `null` with no obstacles at all, or none touching the box (`:285, :322`): "an open field is not a routing failure" (`src/window/components/edges/WireEdge.tsx:83-85`). Also `null` when an end is more than 1 unit inside an inflated card (`:323-335`).
- Graph points: both ends, four corners of each relevant inflated card (skipped when inside another), one lead point per end at `lead = max(20, borderRadius*2 + 4)` along its direction (`:337-367`).
- Legs: straight, or either L between two points; costs cached per leg in "plain" and "bent" form; adjacency built lazily per point (`:520-593`).
- Search: binary heap ordered by cost so far plus Manhattan distance left (`:595-669`); state = point x 5 headings (`:671-673`); a state is queued only if it beats what is held (`:730-739`).
- Penalties: `bendPenalty = 72`, `shortSegmentPenalty = 120` (interior segment under `minInternalSegment = max(borderRadius*2, 14)`), `portPenalty = 180` (leaving or entering against the handle side), `boundaryPenalty = 260` (running along a card edge) (`:453-457, :482-512`).
- An arrival is rejected if its simplified polyline hits a card or has an interior segment under `minInternalSegment` (`:691-703`).
- Output `{path, labelX, labelY, detoured, points}`; `detoured` = neither plain L is clear (`:35-43, :704-722`). Path string from `roundedOrthogonalPath`: `M x,y`, ` L x,y`, ` Q cx,cy x,y`, corner radius `min(radius, len1/2, len2/2)` (`:128-160`).

**Fan cables** (`src/window/lib/wire-loom.ts`):
- Constants: `MIN_FAN = 3`, `LANE_GAP = 3` ("a cable fuses below ~0.4 zoom and separates above 1.5"), `LANE_SPAN_MAX = 72`, `STATION_GAP_MAX = 8`, `LOOM_LEAD = 24`, `SPLIT_BACKOFF = 48`, `LOOM_QUANT = 4`, `SPINE_RADIUS = 8`, `LOOM_CLEARANCE = 14`, `TAIL_LEAD = 12` (`:83-98`).
- Membership: each wire joins the larger of its two handle buckets (`nodeId|side|role`, `:313-315`), ties by key (`:882-909`). "Membership depends only on handle keys, candidate counts, and doc topology, so a drag can never change it" (`:873-877`).
- Lanes: members sorted across the hub axis; `laneOffset = bias + (laneIndex - (laneCount-1)/2) * laneGap`, `laneGap = min(3, 72 / max(1, laneCount-1))`; a dropped member keeps its hole (`:435-466`).
- A member qualifies only if its far side "enters cleanly" and lies more than `LOOM_LEAD + SPLIT_BACKOFF` (72) along the axis; under 3 qualifiers, no fan (`:468-473`).
- Spine: straight first (`:744-745`); else `routeWire` from the hub with `padding: LOOM_CLEARANCE + maxOffset`, `borderRadius: 8`, obstacles sorted by node id for determinism, only the hub card excluded (`:489-503, :747-781`). The SVG path is parsed back to waypoints by regex (`:139-161, :775-779`).
- Retry ladder: backoffs `[48, 24, 12]` (`:790-796`); members dropped nearest-first until a cable stands (`:798-819`).
- Two cables in one corridor: later fan (sorted key order) shifts by `laneBias`, up to 4 passes, and is replanned; if still clashing it dissolves (`:845-871, :914-930`).
- `LoomStrand` fields: `edgeId, bundleKey, hubEnd, hubAxis, laneIndex, laneCount, laneOffset, splayAt, stationAt, lane[], comb[]` in hub-frame coordinates (`:43-73`). `stitchStrand` rebuilds against live ends each render, sliding the comb's last leg onto the live endpoint (`:949-1010`).

**Pair lanes** (`src/window/components/edges/CanvasLoom.tsx:203-330`): exactly two wires on one handle get `-lane` and `+lane` across the side, `lane = min(PAIR_LANE 7, sideExtent/2 - PAIR_LANE_MARGIN 10)`, skipped under `PAIR_LANE_MIN = 2` or when either far end is a fan (`:223-227, :276-300`); ordered by far end so they do not cross (`:302-312`). Applied to planner anchors and published for the fallback elbow (`:332-351`; `src/window/components/edges/WireEdge.tsx:86-90`).

**When it runs** (one effect, `src/window/components/edges/CanvasLoom.tsx:577-672`). A "tick" is one run of this effect for one geometry (`src/window/lib/loom-view.ts:359-360`).

| Situation | What happens | Receipt |
|---|---|---|
| Every run | obstacles collected (regions excluded: `obstacle: node.type !== "group"`), published only if changed; keyed entries of vanished edges pruned | `CanvasLoom.tsx:83-101, :401-411, :429-440, :579-585` |
| A node is dragging | on a new drag signature, incident strands deleted once and the standing plan forgotten; lanes republished; `routesForTick` routes nothing and returns `drop` = incident wires, whose routes are deleted and remembered in `freshlyDropped`; return | `CanvasLoom.tsx:589-625`; `src/window/lib/loom-view.ts:377-379` |
| Settled, same `specsKey` and geometry | nothing | `CanvasLoom.tsx:629-633` |
| Settled, changed | `buildInputs`, lanes, full `planLoom` (timed), strands and corridors published | `CanvasLoom.tsx:635-645` |
| First settled plan | every non-strand wire routed, trigger name `initial` | `CanvasLoom.tsx:665-667, :493` |
| Later settled plans | only wires in `routesOwedWithCause(...)` routed; others keep their route | `CanvasLoom.tsx:650-664` |

"Cause" (`RouteCause`, first that applies wins, `src/window/lib/loom-view.ts:312-352`):

| Cause | Condition | Counter name |
|---|---|---|
| `moved` | an end sits on a moved card, or a moved card's old or new rect lies within `ROUTE_REACH = 56` of the wire's end-to-end box; also ends on moved non-obstacle nodes | `geometry` |
| `changed` | spec key (`id, source, sourceSide, target, targetSide`) differs, or the wire joined or left a cable | `edge-change` |
| `dragged` | a drag had taken its route | `drag` |

Receipts: `src/window/lib/loom-view.ts:227, :273-301, :339-350`; names `src/window/components/edges/CanvasLoom.tsx:472, :489-493`; spec key `:181-183`.

**How it is kept cheap**
- One geometry subscription for all wires, with value equality (`CanvasLoom.tsx:550-553`, `sameGeometry` `:104-123`).
- Sides are computed from live geometry, not from the handles, "reading them would plan every moved wire twice" (`CanvasLoom.tsx:147-154`).
- Nothing routed while the pointer is down (`src/window/lib/loom-view.ts:359-365`).
- Per-edge keyed observables; publishes skip value-equal entries so unchanged wires do not re-render (`src/window/components/edges/WireEdge.tsx:64`; `CanvasLoom.tsx:436-439, :450-463`; `src/window/lib/loom-view.ts:397-468`).
- Router shortcuts: buried-end early exit (`src/shared/wire-route.ts:323-335`), lazy adjacency (`:520-526`), queue dedupe (`:730-733`), box-limited obstacle set (`:271-277`); spine pre-check `swallows` before building a graph (`src/window/lib/wire-loom.ts:758-764`).

**Cost bounds**
- No time budget, iteration cap or wire-count cap exists in the router or loom code read. The only measurement hooks are `canvasPerformance.recordLoomPlan(ms)` and per-trigger call counters (`CanvasLoom.tsx:637-641, :492-493`; `src/window/lib/performance/perf-harness.ts:58-71`).
- Worst case per standalone wire: 4 pads x 4 searches (arithmetic from `src/shared/wire-route.ts:242-248, :294-311`).
- `specsOf` runs `wireSides` (16 pairs) for every wire on every geometry change, drag frames included (`CanvasLoom.tsx:155-179, :554`). `planLoom` is always a full replan on a settled change (`:638`).
- Test bound (counts, not time): 10 x 8 cards of 260 x 96 at pitch 340 x 180, 142 wires; 0 router calls during drag, 12 wires dropped; on drop calls `< edges.length / 3` and more than 90 routes unchanged (`tests/loom-drag-routing.test.ts:19-22, :99-105, :125-130, :147`).

**Known limits**
- Fallback elbow ignores cards: used "when every candidate still collides (dense clusters)" (`src/shared/wire-route.ts:4-6`), and may "sit on a node border" (`:243-246`).
- Wires do not avoid other wires; only cable bands avoid each other (`src/window/lib/wire-loom.ts:822-832, :923-926`).
- Regions are never obstacles (`CanvasLoom.tsx:83-101`); hidden or unsized nodes are skipped, so wires to them are unplanned (`:353-372`).
- Planned routes end at node rect midpoints, strands and fallbacks at RF handle points (table above).

## 4. Coupling to React Flow

| Read site | What is read from RF | Receipt |
|---|---|---|
| `CanvasLoom` | `store.nodeLookup.values()`; per node `id, type, hidden, dragging, width, height, measured.{width,height}, style.{width,height}, internals.positionAbsolute.{x,y}` | `src/window/components/edges/CanvasLoom.tsx:39-49, :51-69, :83-101, :550-553` |
| `CanvasLoom` | each edge's `id, source, target, sourceHandle, targetHandle` | `:155-166, :524-545` |
| `WireEdge` | `EdgeProps`: `id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, markerEnd` | `src/window/components/edges/WireEdge.tsx:52-63` |
| RF `EdgeWrapper` (feeds `WireEdge`) | `edgeLookup.get(id)`, `defaultEdgeOptions`, `nodeLookup.get(source/target)`, `connectionMode`, `elevateEdgesOnSelect`, `zIndexMode` | `RF:2909-2954` |
| RF handle measuring | handle `getBoundingClientRect()` relative to the node, divided by zoom; edge end = outer edge midpoint of the handle box for its side | `RFS:884-901, :1434-1452` |
| `WirePulseFeed` | `store.getState()`: `nodeLookup, transform, width, height`; node `internals.positionAbsolute`, `measured.width ?? width` | `src/window/components/edges/WirePulseFeed.tsx:27-36, :52-62` |
| `FlowTrack`, `WirePulse` | `ViewportPortal` | `src/window/components/edges/FlowTrack.tsx:69`; `src/window/components/edges/WirePulse.tsx:31`; `RF:3810, :3836` |
| `WireEdge` | `EdgeLabelRenderer` | `src/window/components/edges/WireEdge.tsx:138`; `RF:3760, :3802` |
| `NodeShell` | `Handle`, `Position`, `useConnection` (`inProgress, fromNode.id, fromNode.data`), `useUpdateNodeInternals` | `src/window/components/nodes/NodeShell.tsx:61, :114-134, :139-155` |
| `Canvas` | `useEdgesState`; `useConnection(c => c.inProgress)`; `FinalConnectionState.{isValid, fromNode.id, fromHandle.id}`; props `isValidConnection, onConnect, onConnectEnd, onBeforeDelete, onEdgeDoubleClick, onSelectionChange, onEdgesChange` | `src/window/components/Canvas.tsx:548-573, :677-722, :1427, :1560, :1833-1835` |
| `CanvasTierGate` | store `transform` to tier | `src/window/components/CanvasTierGate.tsx:42-70` |
| `CanvasMagnifier` | `rf.getEdges()` | `src/window/components/CanvasMagnifier.tsx:344` |
| CSS | `.react-flow`, `.react-flow__edge`, `.react-flow__edge-path`, `.react-flow__edges`, `.react-flow__edgelabel-renderer`, `.react-flow__viewport`, `.react-flow__handle-<side>`, handle states `connectingfrom, connectingto, valid, clickconnecting` | `src/window/styles/factory-grammar.css:219-265`; `src/window/styles.css:1190-1198, :1520-1548, :1593-1595`; `src/window/styles/canvas-lod-regions.css:44-46, :92-94, :109-117` |

RF utilities that draw:
- `BaseEdge`: one visible `<path class="react-flow__edge-path ...">` plus one invisible `<path class="react-flow__edge-interaction" strokeOpacity=0 strokeWidth=interactionWidth>`, default width 20 (`RF:2570-2571`).
- Each edge is its own `<svg style={{zIndex}}>` holding `<g class="react-flow__edge ...">` (`RF:3014-3026`).
- `getSmoothStepPath` for the fallback only: defaults `offset = 20`, `stepPosition = 0.5`; Junto passes `borderRadius: 8`; emits `M x y`, `L x,yQ x,y x,y`, `L x y` (`RFS:1308-1323, :1356-1373`).
- Strand and planned paths are Junto's own `roundedOrthogonalPath` (`src/shared/wire-route.ts:128-160`).
- `onlyRenderVisibleElements` is not passed (`src/window/components/Canvas.tsx:1823-1885`), RF default `false` (`RF:3728`): every wire is mounted.

## 5. Painting

- Shape: orthogonal runs with rounded corners, radius 8; "Every wire path on the canvas is ... M, L and Q only" (`src/window/lib/flow-track.ts:8-10`).
- Stroke: inline `stroke: var(<token>)`, `strokeWidth: WIRE_WIDTH` = 1.2 canvas units, `--wire-hue` set to the same colour (`src/window/components/edges/WireEdge.tsx:124-130`; `src/window/lib/flow-track.ts:25`). Round caps and joins (`src/window/styles/factory-grammar.css:199-201`). No width rule per tier and no non-scaling stroke on wires (grep found `vectorEffect` only in `src/window/components/pad/PadEditor.tsx`), so on-screen width is 1.2 x zoom (arithmetic).
- No verb: `var(--wire-verb-unset)` (`src/window/components/edges/WireEdge.tsx:49-50, :72-73`).

| Token | Dark | Bright | Receipt |
|---|---|---|---|
| `--wire-verb-messages` | `oklch(0.68 0.065 240)` | `oklch(0.53 0.07 236)` | `src/window/styles/factory-grammar.css:182, :194` |
| `--wire-verb-navigates` | `oklch(0.5 0.02 190)` | `oklch(0.44 0.025 192)` | `:181, :193` |
| `--wire-verb-flows` | `oklch(0.9 0.01 250)` | `oklch(0.3 0.01 250)` | `:175, :191` |
| `--wire-verb-derives` | `var(--wire-verb-flows)` | same | `:178` |
| `--wire-verb-unset` | `oklch(0.48 0.008 250)` | `oklch(0.62 0.008 250)` | `:185, :196` |

| State | Paint | Receipt |
|---|---|---|
| Rest | path `opacity: 0.07`; edge `pointer-events: none` | `src/window/styles/factory-grammar.css:219-224` |
| Loupe held (`data-wires="shown"`) or connecting | path `opacity: 0.9` | `:225-227` |
| In a focus cone (`impact-edge-in`) | path `opacity: 1` | `:228-230` |
| Outside the cone in impact or connection focus mode | edge `opacity: 0.12 !important`, `pointer-events: none` | `src/window/styles.css:1189-1194` |
| Hover (not selected) | `filter: drop-shadow(0 0 2px color-mix(in oklab, var(--wire-hue) 50%, transparent))` | `src/window/styles/factory-grammar.css:248-250` |
| Selected | `opacity: 1`; `drop-shadow(0 0 1px var(--wire-hue)) drop-shadow(0 0 5px color-mix(in oklab, var(--wire-hue) 60%, transparent))` | `:251-256` |
| `flows` or `derives` | hairline `stroke-opacity: 0 !important; filter: none`; a track is drawn instead | `:262-265`; `src/window/components/edges/WireEdge.tsx:101-112, :132` |

- State changes ease: `stroke 420ms cubic-bezier(.22,.61,.36,1), filter 160ms ease-out, opacity 240ms ease-out`; none under reduced motion (`src/window/styles/factory-grammar.css:202-205, :257-259`).
- Layering: regions z 0 plus depth, wires 16, cards 32 (`src/window/lib/flow-nodes.ts:17-18, :235`; `src/window/lib/flow-edges.ts:13-14`); tracks and pulses at `--layer-canvas-track: 1000`, above cards, under a hovered far seat (2000) and seat clusters (3000) (`src/window/styles/layers.css:19-23`). `elevateEdgesOnSelect={false}`: "A wire never rises over a card, selected or not" (`src/window/components/Canvas.tsx:1879-1880`).
- Labels: none visible. One invisible midpoint button per wire, 14 x 14, `opacity: 0`, `pointer-events: none`, "Keyboard only" (`src/window/components/edges/WireEdge.tsx:138-161`; `src/window/styles.css:1602-1608`). The sentence shows in the bottom bar (section 7).
- Markers: none. `markerEnd` is passed through but no edge sets it (`src/window/components/edges/WireEdge.tsx:62, :119`; `src/window/lib/flow-edges.ts:70-79`).

Zoom: range 0.15 to 2.5 (`src/window/components/Canvas.tsx:1881-1882`). Tiers: near `>= 0.62`, mid `>= 0.34`, far `>= 0.2`, else overview, hysteresis 0.03 (`src/window/lib/canvas-tier.ts:28-34, :38-56`), stamped as `html[data-canvas-tier]` and `canvasTier$` (`:70-77`).

| Tier | Wire change | Receipt |
|---|---|---|
| near | full | n/a |
| mid | midpoint buttons, pulses and pulse holds `visibility: hidden` | `src/window/styles/canvas-lod-regions.css:44-46` |
| far | also `.react-flow__edge-path { stroke-opacity: 0.4 }`; handles hidden | `src/window/styles/canvas-lod-regions.css:92-94`; `src/window/styles/canvas-lod.css:140-144` |
| overview | `.react-flow__edges` and the label renderer `visibility: hidden !important`, except edges holding a track path | `src/window/styles/canvas-lod-regions.css:109-117` |
| all | track scale `near 1, mid 1.75, far 3, overview 5` | `src/window/lib/flow-track.ts:42-52` |

## 6. Motion on wires

**Flow track** (verbs `flows`, `derives`; `src/window/lib/flow-track.ts`, `src/window/components/edges/FlowTrack.tsx`, `src/window/components/edges/flow-track.css`)
- Geometry: `TRACK_WIDTH = 1.8` (1.2 x 1.5), `TRACK_PERIOD = 18`, `TRACK_ARM = 4`, `TRACK_SPREAD = 4.4`, `DERIVE_BACK = 3`, `DERIVE_TIP = 3.5` (`flow-track.ts:25-40`). Strip height `(4.4 + 1.8) * 2 * fit` (`:199`).
- Mark: `flows` is an open chevron polyline, round caps and joins; `derives` is a filled triangle with a `0.6 * fit` stroke (`flow-track.ts:207-220`). Drawn as an SVG data-URI mask, repeated along x, filled with `currentColor` (`flow-track.css:46-55`); tiles cached by `verb:scale:fit` (`FlowTrack.tsx:113-123`).
- Layout: one clipped strip per straight run at least one period long, rotated to the run's heading; corners carry no marks; a lane jog up to half a chevron height is ridden through (`flow-track.ts:118-151`; `FlowTrack.tsx:53-55, :71-98`). Marks are phased by distance walked: mover `left: -(run.at % period) - period`, marks `width: run.length + 2 * period` (`FlowTrack.tsx:90-96`).
- `flows` motion: mover `translateX(0)` to `translateX(100%)` (one period) in `450ms linear infinite`, source to target (`flow-track.css:40-42, :56-59`). "40 canvas units a second at near" (`flow-track.ts:34-35`); 70, 120, 200 units a second at mid, far, overview (arithmetic from the scale table).
- `derives` motion: no slide; run opacity 1 to 0.4 to 1 in `1600ms ease-in-out infinite` (`flow-track.css:43-45, :60-63`).
- Clock: wall time; `--flow-track-t0 = -(Date.now() % 450)ms`, `--flow-track-breath-t0 = -(Date.now() % 1600)ms`, resynced when surface motion returns (`FlowTrack.tsx:139-153`).
- Concurrency: no cap. A run animates only while it intersects the window: one shared `IntersectionObserver`, `rootMargin: "0px"`, toggling `data-track-visible` on the DOM (`FlowTrack.tsx:127-188`).
- Side by side: `trackFit` shrinks the whole chevron where another run lies alongside, never below near size; spacing stays the tier's (`flow-track.ts:188-196`). Room comes from `trackClearances` over every run of every track, all pairs (`flow-track.ts:159-186`; `FlowTrack.tsx:105-111`).
- Selected: `filter: drop-shadow(0 0 2px color-mix(in oklab, currentColor 60%, transparent))` (`flow-track.css:64-67`).
- Stops: paused under `html[data-surface-motion="paused"]`, `animation: none` under reduced motion (`flow-track.css:68-78`). Never dimmed by rest, focus or tier, because it sits outside the wire's SVG group (`FlowTrack.tsx:26-31`).
- Removal: unmounts with the edge; its runs are deleted from the shared record (`FlowTrack.tsx:59-64`).

**Pulse** (`src/window/lib/wire-pulse.ts`, `wire-pulse-state.ts`, `src/window/components/edges/WirePulse*.tsx`, `wire-pulse.css`)
- Source: main emits one `WireTrafficEvent` per mail message written into a seat (`src/core/work/message-delivery.ts:756-758`), plus failed (`:738-741`) and held (`:801-805`) variants and a held continuation notice (`src/core/ops/ipc-startup.ts:105-119`); published `:120`, relayed `src/app/ipc.ts:154`.
- `WirePulseFeed` (mounted inside `<ReactFlow>`, `src/window/components/Canvas.tsx:1893-1895`) drops the event when: other canvas, `failed`, `held`, document hidden, no joining edge, no `fromNodeId`, or the box spanning both cards misses the viewport (`src/window/components/edges/WirePulseFeed.tsx:45-63`; `wire-pulse.ts:85-100`). Operator mail has no sender, so no pulse (`src/shared/wire-traffic.ts:82-89`).
- Wire choice: any edge joining the two nodes in either direction, `messages` preferred (rank 0, others 2); `reverse` when traffic runs target to source (`wire-pulse.ts:47-72`).
- Drawn only at tier `near`; below it no pulse starts but the sound still plays (`WirePulseFeed.tsx:64-72`).
- Scheduler: one pulse per edge; traffic during a pulse owes at most one follow-up (latest wins); at most `WIRE_PULSE_MAX_ACTIVE = 24` across the canvas, more are dropped; stale entries freed after `WIRE_PULSE_MS + 400` = 1300 ms, checked at the next `fire`, no timer (`wire-pulse.ts:16-20, :285-349`). State is `wirePulses$[edgeId] = {seq, reverse, kind}` (`wire-pulse-state.ts:10-15`; `wire-pulse.ts:270-275`).
- Look: one round-capped dash, weight `WIRE_PULSE_WIDTH = 3.2`, length `0.16 x wire length` plus 3.2 for the caps; colour by kind: notice `--color-violet`, prompt `--color-amber-hi`, answer `--color-green` (`wire-pulse.ts:27-31, :105-107, :260-268`; `wire-pulse.css:35-39`).
- Layout: one clipped strip per straight leg, each leg reaching half the dash weight past a corner; mover is one travel wide (`length + dash`) (`wire-pulse.ts:150-268`; `WirePulseView.tsx:45-63`).
- Motion: `translateX(0)` to `100%` (or `-100%` in reverse), `900ms cubic-bezier(.45, 0, .55, 1) forwards`, all legs on one clock (`wire-pulse.css:26-34, :40-47`).
- End: the first `animationend` calls `wirePulseScheduler.end(edgeId, seq)`, which starts the follow-up or deletes the key; the component unmounts (`WirePulse.tsx:26-41`; `WirePulseView.tsx:42-43`; `wire-pulse.ts:313-323`). Feed unmount clears all (`WirePulseFeed.tsx:75-78`).
- Reduced motion: strips `display: none`; a second SVG path holds the kind colour, `stroke-width: 2.4`, `700ms steps(1, end)`, opacity 0.85 to 0 (`wire-pulse.css:54-77`).
- Dimmed to `opacity: 0.12` outside a focus cone (`wire-pulse.css:48-52`).
- Sound: `playCue("mail", {tone: kind, pan})` unless a near-tier pulse was dropped (`WirePulseFeed.tsx:67-72`).

## 7. Interaction

**Hit area**
- Invisible stroke of width 20 canvas units, or `LANE_GAP` = 3 for cable members ("The 20px default straddles six neighbours at 3px lane spacing") (`RF:2570-2571`; `src/window/components/edges/WireEdge.tsx:121-123`).
- Off at rest: `.react-flow .react-flow__edge { pointer-events: none }`; `visibleStroke` only while `data-wires="shown"` or on `impact-edge-in` edges (`src/window/styles/factory-grammar.css:219-221, :231-234`). "a press on a wire lands on the pane" (`:210-211`).
- `data-wires="shown"` is stamped on the `.react-flow` root while the loupe is active: Alt held with the pointer inside (`src/window/components/CanvasMagnifier.tsx:397-409, :451-463`).
- Cone: the crosshair button on a selected card calls `toggleConnectionFocus(id)` (`src/window/components/nodes/NodeShell.tsx:257-260`); cone membership `src/window/lib/impact-mode.ts:84-127`.

**Hover**: CSS `:hover` on the edge group only (`src/window/styles/factory-grammar.css:248-250`); no hover handler prop is passed to `<ReactFlow>` (`src/window/components/Canvas.tsx:1823-1885`).

**Selection**
- Click on the stroke: RF `addSelectedEdges([id])` (`RF:2960-2969`), then `onSelectionChange` writes `replaceSelection({nodeId, nodeIds, edgeId})` (`src/window/components/Canvas.tsx:697-722`), then `selectedEdgeId` restamps `selected` (`:399-421, :428`).
- Double click: `selectEdge(edge.id)` (`src/window/components/Canvas.tsx:690-696`). Keyboard: the midpoint button (`src/window/components/edges/WireEdge.tsx:156-159`). A newly drawn wire is selected (`src/window/lib/edge-mutations.ts:183`).
- Pane single click clears (`src/window/components/Canvas.tsx:723-728`). Empty selection events from RF are ignored (`:698-701`).
- Selection state: `state$.selectedEdgeId` (`src/window/lib/state.ts:35, :189-194`).

**Delete**
- Keys `["Backspace", "Delete"]` (`src/window/lib/canvas-keys.ts:18`) reach `onBeforeDelete`, which always returns `false` and hands wires to `deleteEdges` (`src/window/components/Canvas.tsx:672-689`). Refused under a focus surface or modal (`:682`).
- `deleteEdges`: reads task impact, `window.confirm("Delete this relation?" + warnings)` (or "N relations"), then one `removed` command (`src/window/lib/edge-mutations.ts:81-103`).
- Also the "Delete relation" key in the bottom bar (`src/window/components/rts/RtsControls.tsx:170-172`).

**Sentence**: `EdgeCommandCard` shows `{from} → {to}` and the verb sentence; `EdgePairStrip` shows verb, sentence and the sibling-verb swap (`reverbed`) (`src/window/components/rts/RtsControls.tsx:117-142, :148-176, :435-461`). Mounted from `src/window/components/rts/RtsBottomBar.tsx:172-173` and `src/window/components/rts/KindSurface.tsx:458-471` (grep only).

**Connect gesture**
- Handles: per card 4 source `s-<side>` and 4 target `t-<side>` (`src/window/components/nodes/NodeShell.tsx:61, :154-156`). `showHandles` defaults true; `TextNode` turns it off for labels, git, files (`NodeShell.tsx:323, :519`; `src/window/components/nodes/TextNode.tsx:282`). Other node components not checked.
- Handle paint: 9px dot, `opacity: 0`, `pointer-events: all`, `cursor: crosshair`, `transition: opacity 0.15s ease`; `::before { inset: -9px }` gives a grab target of about 26px (`src/window/styles.css:1495-1514`). Source sits 2px outward, target 3px inward; source `z-index: 3`, target 2 (`:1518-1527`). Source dots show on card hover and on every card while connecting (`:1533-1535, :1062`). Hidden at far and overview (`src/window/styles/canvas-lod.css:140-144`).
- RF props: `connectionMode={ConnectionMode.Loose}`, `connectionRadius={42}` (`src/window/components/Canvas.tsx:1844-1845`).
- Validity while dragging: `isValidConnection` to `canConnect`, self refused (`src/window/components/Canvas.tsx:545-554`).
- Drop on a handle: `onConnect` to `addEdge(connection)` (`:555`). Drop on a card body: `document.elementFromPoint` then `.closest(".react-flow__node")`, region refused, `addEdge({source, target, sourceHandle: fromHandle.id})` (`:556-573`).
- Two-verb choice (task to task): two target handles `verb:<verb>` cover the left and right halves, bleeding 16px, shown only when the pair offers exactly 2 verbs; `updateNodeInternals(id)` is called because "Handles that appear mid-drag are invisible to React Flow until the node's internals are measured again" (`src/window/components/nodes/NodeShell.tsx:63-67, :90-152`; `src/window/lib/edge-mutations.ts:71-75`). Zone paint: border 72% hue, `border-radius: 10px`, background 16%, 34% on hover or `connectingto`, `z-index: 20`, 120ms ease-out (`src/window/styles/factory-grammar.css:110-128`).
- Commit: `addEdge` takes the dropped zone's verb if the pair admits it, else the pair default; stores `fromSide`/`toSide` parsed from the handle ids; a refusal writes `state$.error` (`src/window/lib/edge-mutations.ts:143-184`; `src/window/lib/model-edits.ts:356-365`; `src/window/lib/mutations.ts:286-292`).
- Drag preview: RF's default connection line. No `connectionLineComponent`, `connectionLineStyle` or `connectionLineType` is passed (`src/window/components/Canvas.tsx:1823-1885`); default type is Bezier (`RF:3175, :3728`), stroke `#b1b1b7`, width 1 (`RFCSS:10-11, :143-145`); `src` has no `--xy-*` override and no rule on the connection line classes (grep).
- While connecting the root gets `is-connecting`, which lifts every wire to `opacity: 0.9` (`src/window/components/Canvas.tsx:1560, :1825`; `src/window/styles/factory-grammar.css:225-227`).
- Batch connects without a drag: `connectMesh`, `disconnectWithin`, `connectAllToTarget` (`src/window/components/Canvas.tsx:1144, :1161, :1288, :1666`; planners `src/window/lib/edge-mutations.ts:186-466`).

## 8. Reuse

| Module | Lines | React | DOM | React Flow | Legend-State | Reusable unchanged |
|---|---|---|---|---|---|---|
| `src/shared/model/wire.ts` | 72 | no | no | no | no | yes (Effect Schema) |
| `src/shared/physics/verbs.ts` | 168 | no | no | no | no | yes (Effect Schema) |
| `src/shared/wire-sides.ts` | 106 | no | no | no | no | yes |
| `src/shared/wire-route.ts` | 794 | no | no | no | no | yes |
| `src/shared/canvas-wire-path.ts` | 176 | no | no | no | no | yes; holds an RF-free copy of the smooth-step corner points (`:67-147`) |
| `src/shared/wire-traffic.ts` | 97 | no | no | no | no | yes |
| `src/shared/node-geometry.ts` | 53 | no | no | no | no | yes |
| `src/window/lib/wire-loom.ts` | 1010 | no | no | no | no | yes |
| `src/window/lib/flow-track.ts` | 220 | no | no | no | no | geometry yes; `trackTile` returns a CSS `url(data:image/svg+xml...)` string |
| `src/window/lib/wire-pulse.ts` | 349 | no | no | no | no | yes |
| `src/window/lib/verb-sentence.ts` | 16 | no | no | no | no | yes |
| `src/window/lib/model-kind.ts` | 70 | no | no | no | no | yes |
| `src/window/lib/model-edits.ts` | 437 | no | no | no | no | yes (wire edits `:321-423` read) |
| `src/window/lib/loom-view.ts` | 483 | no | no | no | yes (`batch`, `observable`) | planners pure (`:186-391`); publishers write observables (`:397-483`) |
| `src/window/lib/flow-edges.ts` | 85 | no | no | type only (`Edge`) | no | logic yes; output type is RF's `Edge` |
| `src/window/lib/convert.ts` | 66 | no | no | no direct import | no | orchestration only |
| `src/window/lib/wire-pulse-state.ts` | 15 | no | no | no | yes | yes |
| `src/window/lib/edge-mutations.ts` | 466 | no | `window.confirm` (`:98`) | no | via `state$` | yes |
| `src/window/lib/impact-mode.ts` | 169 | no | no | no | yes | yes |
| `src/window/lib/canvas-tier.ts` | 398 | no | `document.documentElement` (`:70-77`) | no | yes | tier logic yes (rest of body not read) |
| `src/window/lib/surface-motion.ts` | 128 | no | yes | no | yes | yes |
| `src/window/components/edges/WirePulseView.tsx` | 87 | yes | DOM elements, CSS | no | no | DOM-only; also used by `src/window/kit/index.ts:22` and `src/window/components/onboarding/tour-demo.tsx:184` |
| `src/window/components/edges/WireEdge.tsx` | 168 | yes | SVG | yes | yes | no |
| `src/window/components/edges/CanvasLoom.tsx` | 675 | yes | no | yes (`useStore`) | yes | no; its pure helpers (`specsOf`, `laneOffsets`, `buildInputs`, `movedNodeIds`, `collectObstacles`, `:155-411`) are not exported |
| `src/window/components/edges/FlowTrack.tsx` | 188 | yes | yes (`IntersectionObserver`, style properties) | yes (`ViewportPortal`) | yes | no |
| `src/window/components/edges/WirePulse.tsx` | 43 | yes | no | yes (`ViewportPortal`) | no | no |
| `src/window/components/edges/WirePulseFeed.tsx` | 82 | yes | yes (`document.visibilityState`, `window.junto`) | yes (`useStoreApi`) | via `state$`, `canvasTier$` | no; filter order reusable |
| `src/window/components/edges/flow-track.css`, `wire-pulse.css` | 78, 77 | n/a | CSS | `.react-flow` selectors in `wire-pulse.css:50` | n/a | no |
| `src/window/styles/factory-grammar.css` | 275 | n/a | CSS | `.react-flow*` selectors | n/a | tokens `:173-197` yes; state rules no |
| `src/window/components/nodes/NodeShell.tsx` | 546 | yes | no | yes | yes | no |
| `src/window/components/CanvasMagnifier.tsx` | 511 | yes | yes | yes | no | not assessed beyond wires |
| `src/window/components/Canvas.tsx` | 1937 | yes | yes | yes | yes | no |

## 9. Surprising

- Stored sides do not steer painting: with both ends present `wireSides` always wins (`src/window/lib/flow-edges.ts:38-39, :52-54`), the sides are written only at draw time (`src/window/lib/edge-mutations.ts:171-172`), and `reanchored` has no caller.
- The same side rule runs in three places: model projection (`src/window/lib/flow-edges.ts:52`), the loom on RF geometry (`src/window/components/edges/CanvasLoom.tsx:167`), the phone path (`src/shared/canvas-wire-path.ts:151-154`).
- Wire ends depend on DOM measurement and CSS: RF measures handle boxes with `getBoundingClientRect` (`RFS:884-901`), and Junto shifts those boxes by 2px or 3px with transforms (`src/window/styles.css:1520-1527`). The loom plans from node rect midpoints and says stitching "absorbs the few-px delta" (`src/window/lib/wire-loom.ts:943-947`). Exact offsets not measured.
- (inference) During a drag the model rebuild is deferred (`src/window/components/Canvas.tsx:313-318`), so RF edges keep their pre-drag handles and incident wires draw the fallback elbow between the old sides until the drop commits.
- The SVG path string is the interchange format and is parsed back by regex in three places: `pathWaypoints` (`src/window/lib/wire-loom.ts:139-161`), `flattenWirePath` (`src/window/lib/flow-track.ts:60-83`), `pulsePlan` (`src/window/lib/wire-pulse.ts:157-251`). The router returns `points` (`src/shared/wire-route.ts:41-42`) but `LoomRoute` drops them (`src/window/lib/loom-view.ts:22-27, :212-217`).
- `getSmoothStepPath` and `stitchStrand` run on every `WireEdge` render, the former even when a strand or route wins (`src/window/components/edges/WireEdge.tsx:79-94`).
- Written but unread in `src` (grep): `loomObstacles$` and `loomCorridors$` (only the publisher peeks them, `src/window/components/edges/CanvasLoom.tsx:430, :443`); `LoomStitch.tailPath` (`src/window/lib/wire-loom.ts:937, :1005`); `LoomRoute.detoured` (only compared, `src/window/lib/loom-view.ts:114`); the `answer` pulse colour, since mail maps only to `prompt` or `notice` (`src/shared/wire-traffic.ts:92`).
- Wires are near-invisible and unclickable by default; the comment "paths already select" in `src/window/components/edges/WireEdge.tsx:141-143` holds only in loupe or cone mode (`src/window/styles/factory-grammar.css:208-234`).
- The loupe lens redraws wires as straight 1px centre-to-centre lines in one steel colour at 0.6 alpha, ignoring routes and verbs (`src/window/components/CanvasMagnifier.tsx:146-170`).
- Docs and comments that disagree with the code:
  - `AGENTS.md:272` says "solid strokes only; no dash, width, or arrowhead carries meaning"; `flows` and `derives` draw chevrons and arrowheads at 1.5x weight (`src/window/lib/flow-track.ts:1-6, :16-19, :27`).
  - `src/window/styles/factory-grammar.css:138-155` lists retired verbs and says "a blocked wire takes crimson outright (set in WireEdge)", and `:243` says "crimson included when it is blocked"; `src/window/components/edges/WireEdge.tsx:30` says "Stoppage is not a wire's to show" and sets no crimson.
  - `src/window/components/edges/CanvasLoom.tsx:209` names retired verbs `manages` and `contributes`; `WireEdge.tsx:141` mentions an "edge inspector".
  - `src/shared/model/wire.ts:26` words `mask` as ports "took away"; the code keeps the ports listed (`:68-71`).
- Past bugs recorded in comments: two wires on one handle painting over each other, "one wire reaching the card and one that stops in open space" (`src/window/components/edges/CanvasLoom.tsx:203-211`); a spine planned blind to far cards "disappears into a card body" (`src/window/lib/wire-loom.ts:489-493`); detours that failed before being tried (`:747-751`); unbinding the delete key "swallowed the first delete after the modal closed" (`src/window/components/Canvas.tsx:678-681, :1869-1875`).
- Performance workarounds tied to DOM compositing: tracks and pulses live in the viewport portal "so no card is lifted into a layer of its own" (`src/window/components/edges/WirePulse.tsx:9-13`; `FlowTrack.tsx:26-31`); zero-margin visibility observer, citing operator signal 01M63W6RQY1YT2Q65MCM0N3YQ8 (`FlowTrack.tsx:127-134`); LOD hides with `visibility`, never `display`, "so React Flow's measured sizes and wire anchors do not move" (`src/window/styles/canvas-lod-regions.css:34-35`); handles hidden at far tiers because each "cost the pan a compositor layer of its own" (`src/window/styles/canvas-lod.css:140-141`).
- React-Flow-only behaviours: delete is never performed by RF (`onBeforeDelete` returns `false`, `src/window/components/Canvas.tsx:672-689`); empty selection events on remount are ignored (`:698-701`); body drops are resolved with `document.elementFromPoint` (`:556-573`); landing zones need `updateNodeInternals` (`src/window/components/nodes/NodeShell.tsx:129-134`); focus-mode dimming needs `!important` against inline edge opacity (`src/window/styles.css:1189`).

**Not read**: RF stylesheet beyond the lines cited; `src/window/lib/flow-identity.ts`; `src/window/lib/performance/canvas-performance.ts` body; `perf-harness.ts` beyond `:55-80, :130-150`; `src/window/lib/rts-selection.ts` beyond `:42-43`; `RtsBottomBar.tsx` and `KindSurface.tsx` (grep lines only); `src/core/work/message-delivery.ts` beyond `:725-810`; `src/window/lib/canvas-tier.ts` beyond `:22-90`; `src/shared/physics/schema.ts` (`Port`, kinds); `src/shared/model/base.ts` (`Side`); bodies of the wire tests other than the assertions cited from `tests/loom-drag-routing.test.ts`; `e2e/scenarios/wire-writers.spec.ts`; the minimap; whether `colorMode` is passed to RF. No millisecond figure for routing or planning was found in any file read.
