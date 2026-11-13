# Canvas interaction, camera and write path: inventory of today's behaviour

**Status of every claim:** read from source in the working tree this session; nothing was run in the app. One independent check was run outside the repo (headless Chromium, `pointerup.detail`), noted where used. "RF default" means Junto does not pass the prop, so the library value holds (`StoreUpdater` skips undefined props, rf-react:283-318).

**Path legend** (all absolute under the repository root):

| Short name | Absolute path |
|---|---|
| `Canvas.tsx` | `src/window/components/Canvas.tsx` |
| `components/...`, `lib/...`, `App.tsx` | `src/window/...` |
| `shared/...` | `src/shared/...` |
| `rf-react` | `node_modules/@xyflow/react/dist/esm/index.js` (12.11.2) |
| `rf-system` | `node_modules/@xyflow/system/dist/esm/index.js` (0.0.79) |
| `d3-zoom` | `node_modules/d3-zoom/src/zoom.js` |

---

## 1. Camera

### Limits and input mapping

| Input | Behaviour | Exact constants | Receipt |
|---|---|---|---|
| Zoom range | clamp | `minZoom={0.15}`, `maxZoom={2.5}` (RF defaults 0.5, 2) | Canvas.tsx:1881-1882; rf-react:3728 |
| Plain wheel, two-finger trackpad scroll | Pans, both axes (`panOnScrollMode` not passed, default `Free`) | `panOnScroll`, `panOnScrollSpeed={1.2}`; `deltaNormalize = event.deltaMode === 1 ? 20 : 1`; translate `-(deltaX / currentZoom) * panOnScrollSpeed`, same for Y | Canvas.tsx:1846-1847; rf-react:1298; rf-system:2733-2743 |
| Shift + wheel, off macOS only | Horizontal pan | n/a | rf-system:2737-2740 |
| Trackpad pinch, or Ctrl + wheel (wheel event with `ctrlKey`) | Zoom about the pointer | `zoom = currentZoom * Math.pow(2, pinchDelta)`; `pinchDelta = -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * factor`; `factor = event.ctrlKey && isMacOs() ? 10 : 1`; `scaleTo(d3Selection, zoom, point, event)` | rf-system:2704-2707, 2721-2728; `zoomOnPinch = true` rf-react:3728 |
| Cmd + wheel (macOS), Ctrl + wheel elsewhere | Zoom about the pointer through d3's own wheel handler | `zoomActivationKeyCode = isMacOs() ? 'Meta' : 'Control'`; `isPanOnScroll = panOnScroll && !zoomActivationKeyPressed && !userSelectionActive`; d3 `k = t.k * Math.pow(2, wheelDelta)` clamped to scale extent, same `wheelDelta` function (0.002 per pixel, no factor 10 without `ctrlKey`) | rf-react:3728; rf-system:2958, 2944, 2764-2780; d3-zoom:234-268; comment Canvas.tsx:1864-1865 |
| Scroll-pan gesture end | fires after wheel idle | 150 ms | rf-system:2758-2761 |
| Middle-button drag | Pans; also allowed when started over a node or edge | `panOnDrag={[1]}` | Canvas.tsx:1848; rf-system:2843-2847, 2885-2887 |
| Left drag on empty pane | Marquee, never pan | `selectionOnDrag` | Canvas.tsx:1855 |
| Space + drag | Off | `panActivationKeyCode={null}` (bug comment, section 11) | Canvas.tsx:1849-1854 |
| Double-click zoom | Off, handler removed | `zoomOnDoubleClick={false}` | Canvas.tsx:1867; rf-system:3024-3029 |
| Inertia | None found in code read. d3 wheel gesture ends on an idle timeout. OS trackpad momentum arriving as wheel events is inference | n/a | d3-zoom:234-268 |
| No pan or zoom while a marquee is active | n/a | n/a | rf-system:2853-2855 |
| Elements with `nowheel` / `nopan` classes | Keep wheel / block pan | default class names | rf-system:2861-2868; rf-react:3728. Which Junto elements carry them: not enumerated |

d3 mouse-drag pan internals: not read.

### Keyboard pan (own code, not RF)

| Item | Value | Receipt |
|---|---|---|
| Keys | Arrows and W A S D (`KEY_VECTORS`); Shift boosts | lib/canvas-keyboard-pan.ts:23-32 |
| Speed | `PAN_SPEED_PX_PER_SECOND = 900` (screen px), `PAN_BOOST_MULTIPLIER = 2.4`, `MAX_PAN_FRAME_MS = 64`, `PAN_RAMP_MS = 130` (linear 0 to 1), first frame assumed 16 ms | lib/canvas-keyboard-pan.ts:15-21, 110-136; components/CanvasKeyboardPan.tsx:45 |
| Diagonals | normalised, not faster | lib/canvas-keyboard-pan.ts:95-107 |
| Camera write | `rf.setViewport({x: viewport.x + delta.x, y: viewport.y + delta.y, zoom})` every rAF, no duration | components/CanvasKeyboardPan.tsx:55-60 |
| Listeners | window `keydown`/`keyup` bubble phase, `preventDefault` only; stops on `blur` and `visibilitychange` | components/CanvasKeyboardPan.tsx:81, 100-103 |
| Gate | `!metaKey && !ctrlKey && !altKey`; no `[data-focus-surface], [role='dialog'], [data-canvas-menu-surface]:not(.node-deck-host--docked)` in the document; focus not inside `input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm, .react-flow__node` | lib/canvas-keyboard-pan.ts:43-52, 70-71, 84-92 |

### Keyboard and button zoom

| Trigger | Call | Receipt |
|---|---|---|
| Cmd+Equal, Cmd+Plus (macOS only) | `rf.zoomIn({ duration: 160 })` = `scaleBy(1.2)` | shared/key-table.ts:434-442; lib/key-actions.ts:87; lib/canvas-zoom.ts:21-22; Canvas.tsx:1452-1464; rf-react:504-507 |
| Cmd+Minus | `rf.zoomOut({ duration: 160 })` = `scaleBy(1 / 1.2)` | shared/key-table.ts:443-451; rf-react:508-511 |
| Cmd+0 | `rf.zoomTo(1, { duration: 200 })` | shared/key-table.ts:452-460; Canvas.tsx:1461 |
| RF `<Controls>` zoom in / out buttons (`showZoom` default true) | `zoomIn()` / `zoomOut()` with no duration | Canvas.tsx:1318; rf-react:4558-4584 |

Programmatic zoom is about the view centre: d3 `scaleTo` with no point uses `centroid(extent)` (d3-zoom:109-117, 151-153).

### Every programmatic camera move

| Caller | Call | Padding | Max zoom | Duration | Receipt |
|---|---|---|---|---|---|
| Canvas open (once per `canvasName`, in `useLayoutEffect`, needs `panZoom !== null`) | `rf.setViewport(openingViewport(...))` | `PADDING = 0.18` | `hasRegions ? 1.15 : 1.35`, min = store `minZoom` | none (instant) | Canvas.tsx:515-536; lib/camera-placement.ts:19, 58-75. Anchors `openingAnchors`, `FIRST_CLUSTER = 24`: :21, :45-52 |
| "Fit readable view" Controls button; command bar "Fit view" (`state$.fitViewRequest`) | `fitView({nodes: anchors, ...})` | 0.18 | `regions.length > 0 ? 1.15 : 1.35` | 320 | Canvas.tsx:164-174, 1319, 1446-1450; lib/command-bar-actions.ts:198 |
| "fit all" field tool | `rf.fitView({...})` all nodes | 0.18 | 1.35 | 320 | Canvas.tsx:989-995 |
| Focus one node (`state$.focusNodeId`) | `selectNode(id)` then `fitView({nodes: [node]})`; up to 12 rAF retries until node exists | 0.35 | 1.45 | 360 | Canvas.tsx:475-513 |
| Focus a group (`state$.focusNodeIds`) | `selectNodes(present)` then `fitView`; up to 24 rAF, waits for measured | 0.3 | 1.45 | 360 | components/useCanvasGroupFocus.ts:41-60 |
| Minimap click | `rf.setCenter(x, y, {zoom, duration: 240})` at current zoom | n/a | n/a | 240 | Canvas.tsx:1367-1391 |
| Minimap double-click (dt < 320 ms, within 40 flow px) | zoom `Math.min(Math.max(zoom * 1.55, 0.35), 1.6)` | n/a | 1.6 | 280 | Canvas.tsx:1367-1391 |
| Minimap drag and wheel | `panZoom.setViewportConstrained`, `panZoom.scaleTo(transform[2] * Math.pow(2, pinchDelta * factor))` | n/a | n/a | n/a | components/FactoryMinimap.tsx:343-362, 374-381 (rest of file: other agent, not read) |
| Seat cluster click | `rf.setCenter(cluster.x, cluster.y, { zoom: Math.min(1, Math.max(transform[2], cluster.partsAt * 1.08, PARTED_ZOOM)), duration: 260 })` | n/a | 1 | 260 | components/SeatClusterLayer.tsx:172-173 |
| RF node keyboard focus (`autoPanOnNodeFocus: true`) | `setCenter` on the node at current zoom when it is off screen | n/a | n/a | not re-quoted | rf-react:2312-2326, 3285-3349 |
| Keyboard pan | per-frame `setViewport` | n/a | n/a | none | above |
| Demo bridge (demo mode only) | `rf.fitView`, `rf.setCenter` | caller-supplied | n/a | n/a | demo/camera-bridge.tsx:28-46 |

- Easing: no caller passes `ease` or `interpolate` (grep of Canvas.tsx, useCanvasGroupFocus.ts, SeatClusterLayer.tsx, camera-bridge.tsx, CanvasMagnifier.tsx found none). So RF `defaultEase` cubic in-out `((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2` and d3 `interpolateZoom` apply (rf-system:2696-2703, 2945-2952, 3064-3078).
- `state$.focusNodeId.set` callers: App.tsx:253, components WaitingOnSection.tsx:76, rts/RtsBottomBar.tsx:488, tasks/TaskThread.tsx:34, terminal/TerminalWizard.tsx:33, git/GitWizard.tsx:31, files/FilesWizard.tsx:37, Canvas.tsx:767-851 and :1730 (every create), lib/profiles-state.ts:159, lib/command-bar.ts:33, lib/blocker-cause.ts:66, lib/urgency-step.ts:70, lib/mutations.ts:325 (`addNode` focuses by default). `focusNodeIds.set`: lib/command-group-runtime.ts:298, lib/squads-state.ts:130.

### Auto-pan at edges

| Gesture | State | Constants | Receipt |
|---|---|---|---|
| Card drag | on (`autoPanOnNodeDrag: true`) | `autoPanSpeed: 15`, `calcAutoPan(pos, bounds, speed = 15, distance = 40)`, per rAF | rf-react:3285-3349; rf-system:570-583, 2168-2187 |
| Connection drag | on (`autoPanOnConnect: true`) | same | rf-system:2428-2435 |
| Marquee | on (`autoPanOnSelection = true`) | same speed | rf-react:3728, 1548-1562 |
| Region drag (own handler) | none in the handler | n/a | components/nodes/GroupNode.tsx:232-283 |

### Persistence and side effects

- Camera persistence per canvas: none found. The only placement is `useCanvasViewport`, keyed on a single remembered name (`placedRef`), so by reading a canvas reopens on its computed opening viewport (Canvas.tsx:516-535).
- `onMoveStart={closeMenus}` closes all canvas menus when the camera starts moving (Canvas.tsx:1843).
- Camera rest: `CAMERA_SETTLE_MS = 160` after the last transform change bumps `cameraSettled$` (lib/canvas-tier.ts:67; components/CanvasTierGate.tsx:53-66).

---

## 2. Selection

| Gesture | Behaviour | Receipt |
|---|---|---|
| Click a card | RF selects it, replacing the selection. A press without movement selects on click; a drag selects as the drag starts (`selectNodesOnDrag: true`, `nodeDragThreshold: 1`) | rf-react:1639-1654, 2265-2281, 3285-3349; rf-system:2188-2215 |
| Shift + left press on a card | Window capture-phase `pointerdown`: `preventDefault`, `stopPropagation`, `toggleInSelection(rfStore, nodeId)`. Skipped in editable targets. Never opens, renames or edits | Canvas.tsx:1784-1813; lib/multi-select-gesture.ts:15-24, 51-76 |
| `toggleInSelection` | Sets RF `multiSelectionActive: true` temporarily, `addSelectedNodes([id])` or `unselectNodesAndEdges({nodes:[node], edges:[]})`; if nothing is left, `clearSelection()` | lib/multi-select-gesture.ts:51-76 (:72) |
| Cmd / Ctrl click | Not a multi-select key: `multiSelectionKeyCode="Shift"` | Canvas.tsx:1858 |
| Marquee | Plain left drag starting on the pane element itself; no modifier (`selectionKeyCode={null}`); starts after more than `paneClickDistance = 1` px; previous selection reset at start | Canvas.tsx:1855, 1866; rf-react:1474, 1580-1585, 3728 |
| Marquee containment | `SelectionMode.Partial`: any overlap (`overlappingArea > 0`); skips `selectable === false`, so regions are never marquee-picked | Canvas.tsx:1856; rf-system:354-379; lib/flow-nodes.ts:240 |
| Marquee inside a region | Works: the region wrapper is `pointerEvents: "none"`, so the press reaches the pane | components/nodes/GroupNode.tsx:218-222, 322 |
| Marquee and wires | RF also flags every wire attached to a picked node; `state$` drops the edge when 2 or more nodes are selected | rf-react:1521-1533; Canvas.tsx:712-715 |
| Marquee end | RF shows the `NodesSelection` rectangle (draggable as a group, takes focus); after one rAF a pick of 2 or more opens `MultiSelectMenu` beside the box | rf-react:1617-1621, 2051-2092; Canvas.tsx:1698-1707 |
| Shift + marquee additive | Claimed in a comment (Canvas.tsx:1857). The Pane code read resets the selection at marquee start with no Shift check (rf-react:1585). `getSelectionChanges` not read. Unverified which holds |
| Region select | Own handler on title bar and frame strips: `rfStore.getState().addSelectedNodes([id])`, exclusive; Shift goes through the shared toggle | components/nodes/GroupNode.tsx:289-305 |
| Wire select | Click on the path (RF `addSelectedEdges`); invisible 14x14 midpoint button calls `selectEdge(id)`; double-click calls `selectEdge` only | rf-react:2960-2975; components/edges/WireEdge.tsx:116-161; Canvas.tsx:690-696 |
| Seat cluster member click | `store.getState().addSelectedNodes([id])` | components/SeatClusterLayer.tsx:193 |
| Select all | None found (key table rows :241-621 read; no handler in files read) |
| Pane click | See section 11, finding 1 |
| Escape | Window keydown: ignored while typing; a front browser surface is dismissed first and the selection kept; a modal keeps Escape; otherwise `clearSelection()` | App.tsx:569-590 |

**What is selectable:** cards (`selectable: !region`), wires (RF default), regions only through their own chrome (lib/flow-nodes.ts:240).

**Where it is stored (two layers):**
- RF `selected` flags on the controlled node and edge arrays.
- `state$.selectedNodeId`, `state$.selectedNodeIds`, `state$.selectedEdgeId` (lib/state.ts:31-35); writers `clearSelection` :125-132, `replaceSelection` :144-172, `selectNode` :175, `selectNodes` :180, `selectEdge` :189-194.
- RF to app: `onSelectionChange` (Canvas.tsx:697-722). Empty selections are ignored (:701). 1 node sets `nodeId`; 2 or more set `nodeIds` only; 0 nodes takes the first selected edge.
- App to RF: selection-sync effect, nodes `selected = selectedIds.has(node.id)`, edges `selected = edge.id === selectedEdgeId` (Canvas.tsx:376-434, :402); `stampImpactShell` restamps on every rebuild (Canvas.tsx:231-270).

**What selecting triggers:**
- `NodeResizer` shows (`isVisible={selected}`): components/nodes/NodeShell.tsx:492-503, GroupNode.tsx:354.
- Node toolbar above the card: `NodeToolbar position={Position.Top} offset={8}` (NodeShell.tsx:168, 227; GroupNode.tsx:55).
- Region frame strips are removed while selected so the resizer owns the edges (GroupNode.tsx:296-299, 366).
- Bottom bar reads `state$` selection: single card, multi, or wire pair strip (components/rts/KindSurface.tsx:454-482).
- Connection focus is cleared when the selection moves to another node (Canvas.tsx:703-708).
- Aria label gains ", selected" (Canvas.tsx:148, 440-472).
- No z change: `elevateNodesOnSelect={false}`, `elevateEdgesOnSelect={false}` (Canvas.tsx:1878-1880).
- A note or label already selected enters text edit on the next click (components/nodes/TextNode.tsx:384-415).

**Keyboard navigation:**
- Cards are focusable (`focusable: true`, lib/flow-nodes.ts:239; `tabIndex: 0`, rf-react:2349). RF a11y is on (`disableKeyboardA11y = false`, rf-react:3728).
- Enter on a focused card selects; Escape unselects in RF (`elementSelectionKeys = ['Enter', ' ', 'Escape']`, rf-system:28; rf-react:2282-2294). Space never reaches RF (section 8).
- Wires: same keys (rf-react:3001-3013).
- Space / Backquote: step to the next agent needing attention, `selectNode` plus camera focus (lib/urgency-step.ts:61-73).
- Digit: recall a command group, `selectNodes` plus frame (lib/command-group-runtime.ts:295-300, 350-362).

---

## 3. Dragging cards

| Item | Value | Receipt |
|---|---|---|
| Threshold | `nodeDragThreshold: 1` (RF default), client px distance | rf-react:3285-3349; rf-system:2247-2256 |
| Start filter | left button only, not inside `.nodrag` | rf-system:2294-2300 |
| Snapping | none: `snapToGrid: false` (RF default) | rf-react:3285-3349 |
| Rounding | positions become whole numbers at commit (`Math.round` in `moved`) and the rebuild sets the cards on them | lib/model-edits.ts:163-176; Canvas.tsx:593-598 |
| Multi-drag | every selected draggable node moves with the grabbed one; the marquee rectangle drags the group | rf-system:1995-2026; rf-react:2051-2092 |
| Dragging an unselected card | selects it first (replaces selection) | rf-react:3285-3349 (`selectNodesOnDrag: true`) |
| Constraints | none: no `nodeExtent`, `translateExtent`, `parentId` (grep of `src/window`) |
| During drag | positions live only in RF (`updateNodePositions`, plain `onNodesChange`); no command sent | rf-react:3465-3510; Canvas.tsx:1426, 1832 |
| Rebuild latch | `dragInProgressRef` set at drag start; structural rebuilds queue while it or `regionLabelDrag$` is set, flushed after | Canvas.tsx:315-318, 367-371, 639, 606-609 |
| Reach preview | `startReachPreview` at start, `updateReachPreview(positions, node.id)` per move, `endReachPreview` at end | Canvas.tsx:642, 667, 592 |
| Drop | `onNodeDragStop` calls `finishDrag(true, dropped)`: latch cleared first, then `syncPositions` with every `rf.getNodes()` position overlaid by `dropped` | Canvas.tsx:589-610, 669-671 |
| Command | `syncPositions` then `moved`: one `Move` holding only nodes whose rounded x or y changed; nothing sent when none changed | lib/geometry.ts:45-47; lib/model-edits.ts:163-176; shared/model/commands.ts:100-106, 139 |
| Fallback | window `pointerup` / `pointercancel` then `requestAnimationFrame(() => finishDrag(true))`; unmount mid-drag drops the latch with no write | Canvas.tsx:618-636 |
| Delete mid-drag | `finishDrag(false)` first | Canvas.tsx:683-684 |
| Undo | one drop is one remembered act; Cmd+Z in canvas context | lib/model-authoring.ts:100-115; lib/model-undo.ts:328-367; shared/key-table.ts:413-432 |

### Regions

| Item | Behaviour | Receipt |
|---|---|---|
| RF flags | `draggable: !region`, `selectable: !region`, wrapper pointer-transparent | lib/flow-nodes.ts:240-241; GroupNode.tsx:322 |
| Grab areas | title bar always; left, right, bottom frame strips only while unselected | GroupNode.tsx:366-388 |
| Drag | own handler: left button, not Shift; no threshold; sets `regionLabelDrag$`; window `pointermove` calls `rf.updateNode` for the region and each rider; on up `syncPositions` of all `rf.getNodes()` (one `Move`, skipped when nothing changed) | GroupNode.tsx:232-283 |
| What moves | region only, unless `region.hold`: then every node whose centre lies in the region, nested regions included, snapshotted at drag start, never stored | lib/model-edits.ts:196-215; shared/model/region.ts:152-167 |
| New regions | `hold: false` | lib/model-factories.ts:65-70 |
| Membership | derived, never stored: whole rectangle inside, inclusive (`frameContains`). Dropping a card wholly inside a region makes it a member; dragging it out ends it. No command for membership | shared/model/canvas.ts:91-99, 111-127 |
| Hold toggle | `setRegionHold` | lib/mutations.ts:688-690 |

---

## 4. Resizing

| Item | Value | Receipt |
|---|---|---|
| Resizable kinds | NodeShell `resizable = true` by default; TextNode family `resizable={!holdsSeatRing(kind)}`; FileNode (image) `resizable={false}`; LinkNode (page) `resizable={false}`; regions always | components/nodes/NodeShell.tsx:321, 492; TextNode.tsx:281; FileNode.tsx:121; LinkNode.tsx:75, 95; GroupNode.tsx:354 |
| Handles | RF `NodeResizer`: 4 corner handles `['top-left', 'top-right', 'bottom-left', 'bottom-right']`, 4 edge lines `['top', 'right', 'bottom', 'left']`; shown only when selected | rf-system:3115-3116; NodeShell.tsx:493-501 |
| Handle size | `.junto-resize-handle` 10 px | styles.css:1056 (`src/window/styles.css`) |
| Min, cards | `minWidth={bare ? 48 : 170}`, `minHeight={bare ? 24 : 72}` | NodeShell.tsx:495-496 |
| Min, regions | `minWidth={320} minHeight={180}` | GroupNode.tsx:354 |
| Max | not passed; RF default `Number.MAX_VALUE` | rf-react:4976-4981 |
| Aspect | `keepAspectRatio` not passed, default false. Modifier behaviour inside XYResizer: not read | rf-react:4976-4981 |
| Commit | `onResizeEnd={(_event, params) => resizeNode(id, params)}` then `resized`: a `Move` entry with `size` | NodeShell.tsx:501; lib/geometry.ts:35-37; lib/model-edits.ts:179-194; shared/model/commands.ts:100-106 |
| During resize | RF applies size and position changes to its own list; no `onResizeStart` handler and no rebuild latch for resize (by reading) | NodeShell.tsx:493-501; Canvas.tsx:315-318 |
| Region resize and children | children do not move or scale; membership and nesting depth are recomputed from rectangles | shared/model/canvas.ts:95-99; GroupNode.tsx:167-171 |
| Region from selection | `MultiSelectMenu` creates a region around the selection with pad 48 | Canvas.tsx:1110-1122 |

---

## 5. Connecting wires

| Item | Behaviour | Receipt |
|---|---|---|
| Handles | 8 per card: source `s-<side>` and target `t-<side>` on 4 sides | NodeShell.tsx:154-156 |
| Handle size and hit area | 9 px dot, `opacity: 0`, `cursor: crosshair`; hit area `::before { inset: -9px }` | styles.css:1495-1514 |
| Visibility | source dots on `.junto-node:hover`; all cards show dots while connecting (`.react-flow.is-connecting .junto-handle--source { opacity: 1; }`); hidden at far and overview tiers | styles.css:1062, 1533-1549; `src/window/styles/canvas-lod.css`:142-144 |
| Start | press and drag from a handle, `connectionDragThreshold: 1` (RF default) | rf-react:3285-3349; rf-system:2406-2561 |
| Click-to-connect | inherited on: `connectOnClick: true` (click a handle, then another) | rf-react:3285-3349, 1909-1945, 1970 |
| Mode | `ConnectionMode.Loose`: any handle to any handle on another card | Canvas.tsx:1844; rf-system:2599-2602 |
| Snap radius | `connectionRadius={42}` (RF default 20); handle under the pointer preferred | Canvas.tsx:1845; rf-system:2332-2368, 2569-2574 |
| Live validity | `isValidConnection`: both ends present and different, then `canConnect(nodeAt(canvas, source), nodeAt(canvas, target))` | Canvas.tsx:548-554 |
| `canConnect` | false for `region`, `label`, `git`, `files`, or a kind this build has off; else `verbsForDraw(...).verbs.length > 0` | lib/edge-mutations.ts:62-69 |
| Verb landing zones | extra target handles with id `verb:<verb>`, `VERB_ZONE_BLEED = 16`, shown during a connection | NodeShell.tsx:67, 90-152; lib/edge-mutations.ts:71-75 |
| Valid drop | `onConnect` calls `addEdge(connection)` | Canvas.tsx:555 |
| Drop on a card body | `onConnectEnd` when RF says not valid: `document.elementFromPoint`, closest `.react-flow__node`, not self, not a region, then `addEdge({source: from, target, sourceHandle})` | Canvas.tsx:556-573 |
| What a plain connect stamps | id `edge-${ulid()}`; `verb` = the landing zone's verb when the pair admits it, else `defaultVerbForPair`; `fromSide` / `toSide` parsed from handle ids; direction flipped when only the reverse pair has verbs; refusals `self, missing, label, git, files, disabled, no-verb, duplicate, cycle` (cycle only for task-path verbs) | lib/edge-mutations.ts:143-184; lib/model-edits.ts:310-381; lib/mutations.ts:286-292 |
| Command | `{ _tag: "Add", canvas, nodes: [], wires: [wire] }`; the new wire is then selected (`selectEdge(drawn)`) | lib/model-edits.ts:380; lib/edge-mutations.ts:183 |
| Refusal | nothing sent; a line is set on `state$.error` (for example "That relation already exists.") | lib/edge-mutations.ts:106-141, 175-178 |
| Feedback | root class `is-connecting` from `useConnection((c) => c.inProgress)`; RF default connection line (no custom line component passed); auto-pan | Canvas.tsx:1560, 1825 |
| Reconnect | off: `onReconnect` not passed, so `isReconnectable` is false | rf-react:2920-2921 |
| Delete | select a wire, Backspace or Delete, then `deleteEdges`: `window.confirm("Delete this relation?")` or `"Delete N relations?"` plus impact warnings, then one `Remove` | Canvas.tsx:685-687; lib/edge-mutations.ts:81-103 |
| Bulk | `connectAllToTarget`, `connectMesh`, `disconnectWithin`; `ConnectEditor` calls `addEdge({source, target})` | lib/edge-mutations.ts:352-385, 427-441, 464-466; components/rts/ConnectEditor.tsx:62-66 |
| Verb swap, re-anchor | writers `reverbed`, `reanchored`, `rewired`; command tags not re-quoted (wires agent) | lib/model-edits.ts:404-423 |

---

## 6. Creating and deleting

### Create

| Path | Position | Receipt |
|---|---|---|
| "add item" field tool (palette deck, click actions, no drag from palette) | first 6 nodes: grid `{ x: (slot % 3) * 340 - 120, y: Math.floor(slot / 3) * 190 - 60 }`; after that `findOpenPosition(nodes, viewportCentre, size)` (gap 28, spiral) | Canvas.tsx:939-960; lib/geometry.ts:14-32 |
| Right-click on empty pane or region chrome | deck actions place the item centred on the click: `{ x: Math.round(point.x - size.width / 2), y: Math.round(point.y - size.height / 2) }` | Canvas.tsx:1003-1015, 1647-1650 |
| Placement sizes | note `{240,100}`, region `{560,320}`, tasks / artifacts / automations `{240,120}`, git / files `{280,128}`, terminal `{260,110}`, page `{260,110}`, label `{160,40}`, agent `AGENT_NODE_SIZE = { width: 216, height: 56 }` | Canvas.tsx:758-853; shared/node-geometry.ts:12 |
| Git, files, terminal | window CustomEvents `junto:new-git`, `junto:new-files`, `junto:new-terminal` carrying the position; wizards or direct create | Canvas.tsx:814-828, 1565-1602 |
| Stacking | every new node gets `z: topZ(canvas)` | Canvas.tsx:749-751; lib/model-edits.ts:263-267 |
| Ids and factories | `${prefix}-${ulid()}`, coordinates rounded; defaults per kind | lib/model-factories.ts:27-157 |
| After create | `addNode`: `selectNode(id)`, one `Add`, then on a 0 ms timeout `focusNodeId` (camera glide), `editNodeId` (non-regions unless `edit: false`), `regionPathsNodeId` (regions) | lib/mutations.ts:301-330 |
| Image file drop | `onDragOver` accepts only `dataTransfer.types` including `"Files"`, `dropEffect = "copy"`; `onDrop` places at pointer minus (140, 100), each further image offset by 24; accepted: `file.type.startsWith("image/")` or `/\.(png|jpe?g|gif|webp|bmp)$/i` | Canvas.tsx:1724-1758; lib/image-content.ts:86-89 |
| Image paste | window `paste`; ignored in `input, textarea, [contenteditable='true']`; placed at window centre minus (140, 100) | Canvas.tsx:1760-1782 |
| Node copy / paste, duplicate | none found |
| Double-click pane to add a note | coded (note at pointer minus (120, 50)) but see section 11, finding 1 | Canvas.tsx:723-732 |

### Delete

| Item | Behaviour | Receipt |
|---|---|---|
| Keys | `CANVAS_DELETE_KEY_CODE: string[] = ["Backspace", "Delete"]`, bound by RF at document level, not inside inputs | lib/canvas-keys.ts:18; Canvas.tsx:1868-1877; rf-react:1235-1250; rf-system:860-868 |
| Gate | `onBeforeDelete` always returns false (RF never deletes). Refused when `canvasKeyboardTaken(surfaces.length > 0, topModal() !== undefined)` | Canvas.tsx:672-689; lib/canvas-keys.ts:21-22 |
| Rule | selected nodes win: `deleteNodes(ids)`; only when no node is selected, `deleteEdges(ids)` | Canvas.tsx:685-687 |
| Node confirm | `window.confirm`: "Delete this node?" or "Delete N nodes?" plus impact text plus " Connected edges (N) will also be removed." | lib/mutations.ts:81-82, 391-403 |
| Side flows | page stop flow, terminal delete lease | lib/mutations.ts:405-457, 461-558 |
| Command | one `Remove` (nodes and their wires) | lib/mutations.ts:582-596; lib/model-edits.ts:273-287 |
| Other entry points | toolbar delete button (`deleteNode`), multi-select menu "delete N", wire command card | NodeShell.tsx:175-178, 298-301; Canvas.tsx:1189; components/rts/RtsControls.tsx:148-176 |

---

## 7. Opening and other card gestures

| Gesture | Behaviour | Receipt |
|---|---|---|
| Double-click a card | handled inside the node component (no `onNodeDoubleClick` prop); opens the card's surface by kind: terminal / agent to terminal, task / artifacts / automations / git / files to work, page to browser dock, note to edit | components/nodes/TextNode.tsx:442-465; lib/activate-node-surface.ts:36-94; LinkNode.tsx (page, `openDockBrowser`) |
| Open button on the card | `onOpen` | NodeShell.tsx:504-518 |
| Cmd+Enter / Ctrl+Enter | opens the surface of `state$.selectedNodeId` | lib/activate-node-surface.ts:101-104; lib/key-actions.ts:113 |
| Note and label text edit | click when already selected, double-click, Enter or Space; commit rules in the textarea | TextNode.tsx:363-440, 510-540 |
| One-shot edit request | `state$.editNodeId` consumed by the card | TextNode.tsx:152-184; GroupNode.tsx:197-201 |
| Region rename | double-click the name (ignored with Shift); `renameGroup` only if the draft changed | GroupNode.tsx:134-135, 210-213 |
| Wire double-click | selects only | Canvas.tsx:690-696 |
| Right-click, pane | add menu (`ContextModeDeck`) at the point | Canvas.tsx:1647-1650 |
| Right-click, card (in this order) | (1) 1 or more selected, this card not selected, not a region, connectable sources exist: Shift+right-click connects all to it at once and keeps the selection, otherwise `TargetConnectMenu`; (2) more than 1 selected and this card selected: `MultiSelectMenu`; (3) agent card: `SeatMenu`; (4) region: add menu; (5) anything else: no menu, no `preventDefault` | Canvas.tsx:1651-1688 |
| Right-click, marquee rectangle | `MultiSelectMenu` | Canvas.tsx:1689-1693 |
| Right-click, wire | none (`onEdgeContextMenu` not passed) | Canvas.tsx:1823-1885 |
| Menus | mutually exclusive; closed on pane click and on camera move start; keyboard: opened by key takes focus, Arrow Up / Down, Home, End, Escape | Canvas.tsx:1611-1646, 1708-1711, 1843, 868-904 |
| Menu placement | `GAP = 8`, `MARGIN = 8` | lib/menu-placement.ts |
| Hover | handles appear on card hover; region frame strips tint the border and carry `title="Drag region"`; card hover hooks and overlay | styles.css:1533-1535; GroupNode.tsx:306-310, 373-386; NodeShell.tsx:468-469; TextNode.tsx:241-272 |
| Toolbar actions | delete, connection focus toggle (`toggleConnectionFocus`), jump to blocker cause | NodeShell.tsx:158-309; lib/state.ts:225-229 |
| Tooltips | native `title` only in what was read; card internals: other agent, not enumerated |

The product's own pointer inventory is `CANVAS_HELP_POINTER` (components/help/CanvasInteractionMap.tsx:16-39).

---

## 8. Keyboard

**Registration:** one dispatcher, `installKeyDispatcher(KEY_ACTIONS)` (App.tsx:505), window capture-phase `keydown` / `keyup` (lib/key-dispatcher.ts:181-183). A hit does `preventDefault` and `stopPropagation` unless the action returns false (:131-134, :154). `isComposing` ignored; non-repeating shortcuts swallow repeats (:150-153). Context order: switcher, dialog, operator, terminal, field, working, canvas (:57-64).

| Key | Action | Context | Receipt |
|---|---|---|---|
| Cmd+Z / Ctrl+Z | undo | canvas only | shared/key-table.ts:413-423; lib/key-actions.ts:85; lib/mutations.ts:332-354 |
| Cmd+Shift+Z / Ctrl+Shift+Z | redo | canvas only | shared/key-table.ts:424-432 |
| Cmd+Equal, Cmd+Plus, Cmd+Minus, Cmd+0 | zoom in, out, reset | macOS only | shared/key-table.ts:434-460 |
| Cmd+Enter / Ctrl+Enter | open selected card | canvas | shared/key-table.ts:521-529 |
| Space, Backquote | next agent needing attention (select and camera focus); Space passes through when focus is on a pressable control that is not `.react-flow__node, .react-flow__edge, .react-flow__pane` | canvas | shared/key-table.ts:310-319; lib/key-actions.ts:84; lib/urgency-step.ts:39-56 |
| Cmd+Backquote, Cmd+Shift+Backquote | urgency next / previous (repeats) | table row; action body not read | shared/key-table.ts:320-341 |
| Digit | recall command group (select and frame) | canvas | shared/key-table.ts:291-299; lib/command-group-runtime.ts:350-362 |
| Cmd+Digit / Ctrl+Digit | assign selection to slot ("Saving never moves the camera") | canvas | shared/key-table.ts:282-290; lib/command-group-runtime.ts:337-344 |
| Cmd+Digit | jump to slot | terminal, field, working | shared/key-table.ts:300-309; lib/command-group-runtime.ts:369-387 |
| Cmd+K / Ctrl+K, Slash, Cmd+I, Cmd+T, Cmd+W | search, search, feed, capture, close front | app level | shared/key-table.ts:241-281, 530-539 |

Keys the dispatcher leaves to their own surface (shared/key-table.ts:579-612):

| Key | Handler | Receipt |
|---|---|---|
| Arrows, W A S D, Shift variants | `CanvasKeyboardPan` | section 1 |
| Backspace, Delete | RF delete key into `onBeforeDelete` | section 6 |
| Escape | App.tsx window handler; canvas menus; RF on a focused card | App.tsx:569-590; Canvas.tsx:884-889 |
| Alt (hold) | magnifier (other agent) | shared/key-table.ts:604-612 |
| Shift | multi-select modifier (pointer) | Canvas.tsx:1784-1813, 1858 |
| Enter, Tab, arrows on a focused card | RF a11y (select, focus, nudge) | rf-react:2282-2326 |

**Focus law effect:**
- Typing: `isOperatorTyping` (lib/focus-ownership.ts:114-116, selector :24-32) blocks Escape deselect; `NOT_TYPING` rows such as Slash (shared/key-table.ts:52-57).
- Surface or modal in front: `canvasKeyboardTaken` refuses delete (lib/canvas-keys.ts:21-22); `canvasOwnsKeyboard` blocks pan; undo, redo and the other canvas rows resolve only in the canvas context ("a surface in front ... has its own undo", shared/key-table.ts:413-423).
- A card holding DOM focus blocks keyboard pan and hands arrows to RF (lib/canvas-keyboard-pan.ts:46-52).
- `resolveKey`, overrides, and key-table rows after :621 (in-search and in-capture rows): not read. `claimFocus` and `recentGestureKind` bodies: not read.

---

## 9. React Flow surface used

### Canvas.tsx (complete)

| Kind | Item | Value / use | Line |
|---|---|---|---|
| Component | `ReactFlow` | root | 1823 |
| Component | `Controls`, `ControlButton` | `showFitView={false} showInteractive={false}`, custom fit button | 1318-1319 |
| Component | `Panel` | `top-left` impact chip; `bottom-center` bottom bar | 1491, 1914 |
| Enum | `ConnectionMode.Loose`, `SelectionMode.Partial` | props | 1844, 1856 |
| Types | `Connection`, `EdgeMouseHandler`, `FinalConnectionState`, `Node`, `OnBeforeDelete`, `OnNodeDrag` | n/a | 16 |
| Hook | `useNodesState`, `useEdgesState` | controlled arrays | 1426-1427 |
| Hook | `useReactFlow` | instance | 940, 1006, 1048, 1316, 1327, 1428 |
| Hook | `useStore` | `width`, `height`, `minZoom`, `panZoom !== null`; ids of `nodes.filter(selected)` | 520-523, 1050 |
| Hook | `useStoreApi` | passed to `toggleInSelection` | 1791 |
| Hook | `useConnection` | `connection.inProgress` | 1560 |
| Instance | `fitView` | 168, 493, 990 |
| Instance | `setViewport` | 534 |
| Instance | `setCenter`, `getZoom` | 1378-1387 |
| Instance | `zoomIn`, `zoomOut`, `zoomTo` | 1458-1461 |
| Instance | `getNode`, `getNodes` | 483, 647; 165, 602, 1087, 1091, 1656, 1700 |
| Instance | `screenToFlowPosition` | 730, 955, 1008, 1751, 1774 |
| Instance | `flowToScreenPosition`, `getNodesBounds` | 1702-1704 |

`<ReactFlow>` props (Canvas.tsx:1823-1885):

| Prop | Value |
|---|---|
| `className` | `is-connecting`, `connection-focus-mode` or `impact-mode` |
| `nodes`, `edges`, `nodeTypes`, `edgeTypes` | controlled arrays; types from `components/nodes/index.ts` (`memo(Component, sameCard)`) and edge type `wire` |
| `onNodesChange`, `onEdgesChange` | the plain ones from `useNodesState` / `useEdgesState` |
| `onConnect`, `onConnectEnd`, `isValidConnection` | section 5 |
| `onNodeDragStart`, `onNodeDrag`, `onNodeDragStop` | section 3 |
| `onBeforeDelete` | section 6 |
| `onEdgeDoubleClick`, `onSelectionChange`, `onPaneClick` | sections 2, 7, 11 |
| `onPaneContextMenu`, `onNodeContextMenu`, `onSelectionContextMenu`, `onSelectionEnd` | section 7 |
| `onDragOver`, `onDrop` | image files |
| `onMoveStart` | `closeMenus` |
| `connectionMode` | `ConnectionMode.Loose` |
| `connectionRadius` | `42` |
| `panOnScroll`, `panOnScrollSpeed` | true, `1.2` |
| `panOnDrag` | `[1]` |
| `panActivationKeyCode` | `null` |
| `selectionOnDrag` | true |
| `selectionMode` | `SelectionMode.Partial` |
| `multiSelectionKeyCode` | `"Shift"` |
| `selectionKeyCode` | `null` |
| `zoomOnDoubleClick` | `false` |
| `deleteKeyCode` | `["Backspace", "Delete"]` |
| `elevateNodesOnSelect`, `elevateEdgesOnSelect` | `false` |
| `minZoom`, `maxZoom` | `0.15`, `2.5` |
| `proOptions` | `{ hideAttribution: true }` |
| `style` | `{ background: fieldTheme.ground }` |

Not passed anywhere in `src/window` (grep), so RF defaults hold: `onNodeClick`, `onNodeDoubleClick`, `onEdgeClick`, `onEdgeContextMenu`, `onReconnect`, `onSelectionDrag*`, `snapToGrid`, `nodeDragThreshold`, `autoPan*`, `disableKeyboardA11y`, `zoomActivationKeyCode`, `translateExtent`, `nodeExtent`, `onlyRenderVisibleElements`. No `<Background>`, no RF `<MiniMap>` (own `FactoryMinimap`).

Children mounted inside `<ReactFlow>`: `CanvasLoom`, `WirePulseFeed`, `CanvasMagnifier`, `CanvasKeyboardPan`, `RegionGlanceGate`, `CanvasTierGate`, `SeatClusterLayer`, `RegionUrgencyGate`, `ImpactSeedChip`, bottom bar panel (Canvas.tsx:1890-1916).

### Other files in `src/window` (27 files import `@xyflow/react`)

| File | RF items |
|---|---|
| App.tsx:4, 634-637 | `ReactFlowProvider` wrapping `<Canvas />` and `<DemoCameraBridge />` |
| main.tsx:4 | `@xyflow/react/dist/style.css` |
| components/nodes/NodeShell.tsx:9-16 | `Handle`, `NodeResizer`, `NodeToolbar`, `Position`, `useConnection`, `useUpdateNodeInternals` (:115-134) |
| components/nodes/GroupNode.tsx:4-5 | `NodeResizer`, `NodeToolbar`, `Position`, `useReactFlow` (`getNode`, `getNodes`, `updateNode`, `screenToFlowPosition`), `useStoreApi` (`addSelectedNodes`), `NodeProps` |
| components/nodes/TextNode.tsx:12, FileNode.tsx:8, LinkNode.tsx:4 | `NodeProps` type |
| components/nodes/index.ts:2 | `NodeTypes` type |
| components/nodes/PreambleBubble.tsx:3, 24 | `useStore` |
| components/edges/WireEdge.tsx | `BaseEdge`, `EdgeLabelRenderer`, `getSmoothStepPath` |
| components/edges/CanvasLoom.tsx:12, 550-551 | `useStore` |
| components/edges/WirePulseFeed.tsx:11, 39, 52-56 | `useStoreApi` |
| components/edges/FlowTrack.tsx:2, 69; WirePulse.tsx:1, 31 | `ViewportPortal` |
| components/CanvasKeyboardPan.tsx:2 | `useReactFlow` (`getViewport` / `setViewport`) |
| components/CanvasMagnifier.tsx:3, 419 | `useOnViewportChange`, `useReactFlow` |
| components/CanvasTierGate.tsx:2, RegionGlanceGate.tsx:2, RegionUrgencyGate.tsx:2 | `useStoreApi` (`subscribe`, `getState`) |
| components/FactoryMinimap.tsx:2 | `useStoreApi`, `Node` type; `panZoom.setViewportConstrained`, `panZoom.scaleTo` |
| components/SeatClusterLayer.tsx:4 | `useReactFlow` (`setCenter`), `useStoreApi`, `ViewportPortal` (:284) |
| demo/camera-bridge.tsx:2 | `useReactFlow`, `ReactFlowInstance` (`fitView`, `setCenter`, `setNodes`) |
| lib/camera-placement.ts:1 | `getViewportForBounds`, `Viewport` |
| lib/multi-select-gesture.ts:10 | `useStoreApi` (`multiSelectionActive`, `addSelectedNodes`, `unselectNodesAndEdges`) |
| lib/flow-nodes.ts:1, lib/flow-edges.ts:1 | `Node`, `Edge` types |

Handle ids `s-<side>` / `t-<side>` (lib/flow-edges.ts:52-54); edge `type: "wire"`, `zIndex: 16` (lib/flow-edges.ts:14, 78); node `zIndex` region `0 + depth`, cards `32` (lib/flow-nodes.ts:17-18, 235).

---

## 10. State ownership

### Lives only in React Flow today

| State | Read by Junto at | Notes |
|---|---|---|
| Camera `transform` [x, y, zoom] | CanvasTierGate.tsx:41-70; RegionGlanceGate.tsx; FactoryMinimap.tsx:167, 195-196, 241-244, 267-272, 290-295, 352-361, 375-380, 398; SeatClusterLayer.tsx:123-140, 149, 172-173, 226, 255-272; CanvasLoom.tsx:550-551; WirePulseFeed.tsx:39, 52-56; PreambleBubble.tsx:24; CanvasMagnifier.tsx:296, 339, 343-344, 419 | not persisted, not in any app store. Exact field per receipt not all re-quoted |
| Pane `width`, `height`, `domNode`, `minZoom`, `panZoom` | Canvas.tsx:520-523; CanvasTierGate.tsx:41-63 | `useOnViewportChange` is one shared slot, so gates subscribe to the store instead (CanvasTierGate.tsx:31-33) |
| Live drag positions, `dragging`, `measured`, live resize size | Canvas.tsx:601-604; GroupNode.tsx:274-276 | committed only at drop / resize end |
| Connection in progress | Canvas.tsx:1560; NodeShell.tsx (`useConnection`) | n/a |
| Marquee rectangle, `nodesSelectionActive`, `multiSelectionActive` | lib/multi-select-gesture.ts:51-76 | n/a |
| `selected` flags | Canvas.tsx:1050, 1087, 1091, 1656-1657, 1700 | mirrored to `state$` (section 2) |

### Lives in app stores

| State | Store | Receipt |
|---|---|---|
| Document: nodes, wires, `seq`, per canvas | `modelStore` (Legend-State) | lib/use-model.ts:9; lib/model-store.ts:19-33 |
| RF `nodes` / `edges` arrays | React state from `useNodesState` / `useEdgesState`, rebuilt from `modelStore` by `useCanvasDocument`; identity kept by `keepHeldNodes` | Canvas.tsx:305-473, 1426-1427; lib/flow-identity.ts |
| Selection | `state$.selectedNodeId`, `selectedNodeIds`, `selectedEdgeId`, `connectionFocusNodeId` | lib/state.ts:31-39 |
| One-shot requests | `state$.focusNodeId`, `focusNodeIds`, `fitViewRequest`, `editNodeId`, `regionPathsNodeId`, `nodePaletteOpen`; `canvasZoomRequest$` | lib/state.ts:23-43; lib/canvas-zoom.ts:12 |
| Derived camera signals | `canvasTier$`, `cameraSettled$` | lib/canvas-tier.ts |
| Drag latches | refs `dragInProgressRef`, `pendingRebuildRef`; `regionLabelDrag$` | Canvas.tsx:1429-1430; lib/region-label-drag.ts |
| Menus and wizard anchors | React state in `CanvasGraph` | Canvas.tsx:1561-1610 |
| Undo / redo | per-canvas `createEditHistory(limit = 200)`; `state$.canUndo` / `canRedo` | lib/model-undo.ts:328-367; lib/state.ts:110-111 |

### Write path (shared by sections 3 to 6)

1. A writer in `lib/model-edits.ts` returns `Command[]` from the canvas as it stands.
2. `commitCommands` (lib/mutations.ts:250-268) calls `sendAct` (:126-146), which calls `authoring.act(name, commands, {remember})`.
3. `act` shows the commands in the store at once (optimistic rows), joins a multi-command act into one `Batch`, queues delivery serially ("One act at a time per window"), and records the inverse unless `remember === false` (lib/model-authoring.ts:52-53, 71-78, 100-115; lib/model-undo.ts:279-286).
4. Delivery: `store.deliver` then `api.modelCommand` (lib/model-store.ts:11-15, 344-369).
5. Main answers with `Changed {canvas, seq, nodes, wires, removedNodes, removedWires}`; `applyChanged` drops `event.seq <= seq`, rereads the canvas when `event.seq !== seq + 1` (shared/model/events.ts:14-27; lib/model-store.ts:249-268).
6. Refusal: reread plus `state$.error` = `canvas "<name>" did not take that change: ...` (lib/mutations.ts:126-146; lib/model-store.ts:357-369). A refused undo / redo forgets the history (lib/model-authoring.ts:83-97).
7. The store change triggers the structural rebuild of the RF arrays (Canvas.tsx:272-303, 340-371).

Command set (shared/model/commands.ts): `Add` :127-131, `Remove` :133-137, `Move` :139 with `NodeMove {id, x, y, z?, size?}` :100-106, `Restack` :144-148, `Recolor` :149-153, `Edit` :155, `Rewire` :157, `Reseat` :159-167, `Batch` :177, `GrantOverseer` :183, `CreateCanvas` / `RemoveCanvas` :184-185. `Restack` and `regionDragged` have no canvas caller in what was read (unverified).

Not read: main-process handling of commands; `canvasAfter` body (lib/model-undo.ts:165-272).

---

## 11. Anything surprising

### Findings by reading (none run in the app)

1. **Pane click and pane double-click probably do nothing in app code.** With `selectionOnDrag`, RF 12.11.2 does not bind the pane's `click` handler (`onClick: isSelectionEnabled ? undefined : ...`, rf-react:1630) and instead calls `onPaneClick` from `pointerup` (rf-react:1610-1612). Junto's handler branches on `event.detail === 1` (clear selection) and `=== 2` (new note) (Canvas.tsx:723-732). Headless Chromium 153 logged `pointerup.detail` as 0 for single and double clicks (run outside the repo; Electron here is 43.8.4, not checked). So by reading:
   - a pane click closes menus (Canvas.tsx:1708-1711) and RF clears its own `selected` flags (rf-react:1447), but that empty selection is ignored (Canvas.tsx:701), so `state$` keeps the selection and the next rebuild restamps it;
   - double-click on the pane does not create a note, although the help map lists it (components/help/CanvasInteractionMap.tsx:23) and a comment calls the pane click "the explicit deselection gesture" (Canvas.tsx:698-700);
   - no e2e asserts either behaviour in what was searched; `e2e/scenarios/zz-artifact-task-probe.spec.ts:489, 648` dispatches a synthetic `click` with `detail: 1`, which by the same reading has no bound handler.
   - Paths that do clear `state$` selection: Escape (App.tsx:586-589), command bar "Clear selection" (lib/command-bar-actions.ts:206), last Shift toggle (lib/multi-select-gesture.ts:72), canvas open (App.tsx:118).
2. **Region-hold code in Canvas.tsx is unreachable.** `onNodeDragStart` / `onNodeDrag` handle a held region (Canvas.tsx:574-583, 643-651, 657-666), but regions are `draggable: false` (lib/flow-nodes.ts:241), RF disables drag for them (rf-react:2234-2242) and `getDragItems` skips them (rf-system:1995-2026). Region movement, riders included, runs only through GroupNode.tsx:232-283.
3. **RF keyboard nudge is live and never committed.** With a card holding DOM focus, pan steps aside (lib/canvas-keyboard-pan.ts:46-52) and RF moves selected draggable cards 5 px per arrow, 20 px with Shift (`factor: event.shiftKey ? 4 : 1`, rf-react:1713-1753, 2295-2310). It emits position changes with no drag stop; no Junto code commits them, so the nudge lasts until the next rebuild reverts it or the next drop commits it (`finishDrag` reads every node position, Canvas.tsx:601-604). Whether a mouse click leaves DOM focus on the card wrapper was not checked.
4. **Space on a focused card never reaches RF.** The dispatcher takes it in capture as `alerts.next` because a card matches `CANVAS_ITSELF` (lib/urgency-step.ts:41, 51-56; lib/key-actions.ts:84). Enter still selects.
5. **Marquee selects wires in RF but not in `state$`** for 2 or more nodes (rf-react:1521-1533; Canvas.tsx:712-715).
6. **Two rules for "inside a region":** membership is whole rectangle inside (shared/model/canvas.ts:95-99); riding along on a held region is centre inside, "Deliberately looser" (lib/model-edits.ts:196-201).
7. **Click-to-connect is inherited** (`connectOnClick: true`) and nothing in Junto turns it off (rf-react:3285-3349).
8. **Resize has no rebuild latch**, unlike drag (section 4).

### Workarounds and past-bug comments in the code

| Topic | What the comment says | Receipt |
|---|---|---|
| Space pan key removed | xyflow `useKeyPress` preventDefaults Space with any modifier held, even inside xterm; Shift+Space was dropped from the PTY | Canvas.tsx:1849-1854 |
| Shift is not the selection latch | each Shift press re-registered xyflow's wheel listener and repainted the board (about 10 ms) | Canvas.tsx:1859-1866 |
| Delete key stays bound | unbinding left xyflow's pressed-key set stale and the first delete after a modal matched nothing; refusal moved into `onBeforeDelete` | Canvas.tsx:1868-1876, 678-682; lib/canvas-keys.ts:6-11 |
| Delete never runs in RF | RF removes from its view before the document can refuse | Canvas.tsx:672-676 |
| Double move on drop | latch is cleared before the `Move` is sent, else cards moved once at the drop and once after | Canvas.tsx:593-598 |
| One step short | the window `pointerup` fallback waits a frame, because the pointer goes up before RF applies the last drag step | Canvas.tsx:612-617 |
| Empty selection on remount | RF emits empty selections while the graph remounts, so they are ignored; focus re-applies `selectNode` after `fitView` | Canvas.tsx:698-701, 490-492, 498-500 |
| Shift dominance at window capture | RF's pane capture handler runs before node handlers and would swallow the press | Canvas.tsx:1784-1790 |
| Dragged card drops out in Shift toggle | bug comment in the toggle | lib/multi-select-gesture.ts:55-60 |
| Region click exclusive | `addSelectedNodes` replaces the selection when `multiSelectionActive` is false, relied on to avoid mixed sets | GroupNode.tsx:285-288 |
| No `<Background>` | RF's background re-rendered a full-window SVG pattern per viewport change | Canvas.tsx:1886-1889 |
| No React subscriptions in the graph hook | store changes drive RF through `onChange` then `setNodes`, so the graph does not re-render per kernel tick | Canvas.tsx:1423-1425 |
| Tier scales held through gestures | a zoom sweep wrote them 29 to 83 times; now once per camera rest | components/CanvasTierGate.tsx:22-29 |
| Own minimap | RF's `<MiniMap>` selects the store transform on every viewport change | components/FactoryMinimap.tsx:10 |
| Bottom bar must be an RF child | so the minimap binds to the instance | Canvas.tsx:1913 |
| Menus opened by pointer leave focus alone | so a marquee never moves focus | Canvas.tsx:863-866 |
| Wire hit width | comment on RF's 20 px default interaction width | components/edges/WireEdge.tsx:116-131 |
| Controls blur cost | comment in the controls chrome CSS | styles.css:1558-1582 |

### Behaviours that exist only because RF provides them

- Wheel, pinch and Cmd+wheel mapping, zoom about the pointer, `interpolateZoom` glides with cubic in-out easing.
- Drag threshold 1 px, multi-drag of the selection, the draggable marquee rectangle, auto-pan (speed 15, edge distance 40) on drag, connect and marquee.
- Marquee geometry (Partial overlap), marquee picking attached wires.
- Connection snapping within the radius, Loose mode rule, click-to-connect, default connection line.
- Resizer handles, min clamps and live resize.
- Keyboard a11y: Tab focus, Enter select, Escape unselect, arrow nudge, focus auto-pan to an off-screen card.
- Controls zoom buttons (step 1.2), `NodeToolbar` positioning (internals not read), `ViewportPortal`, `Panel`.
- Default stylesheet for the marquee and selection rectangle: no Junto CSS for `.react-flow__nodesselection` or `.react-flow__selection` found in `src/window`.

### Not read

XYResizer internals (rf-system:3145-3480); d3-zoom mouse-drag pan; `NodeToolbar` internals; RF default stylesheet; `getSelectionChanges`; `canvasAfter` (lib/model-undo.ts:165-272); main-process command handling; `resolveKey` and key-table rows after :621; `claimFocus` / `recentGestureKind` bodies; `CanvasMagnifier` and `FactoryMinimap` beyond their camera calls; bodies of `lib/squads-state.ts`, `lib/profiles-state.ts`, `lib/blocker-cause.ts`.
