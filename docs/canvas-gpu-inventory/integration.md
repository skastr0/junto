# Canvas replacement research: minimap, magnifier, app shell, state, flags, tests

Read-only; nothing was edited or run. Receipts are relative to the repository root. Tags used below: `Canvas.tsx` = `src/window/components/Canvas.tsx`; `FM` = `src/window/components/FactoryMinimap.tsx`; `MAG` = `src/window/components/CanvasMagnifier.tsx`; `App.tsx` = `src/window/App.tsx`; `styles.css` = `src/window/styles.css`; `Rts.css` = `src/window/components/rts/RtsBottomBar.css`; `WC/` = `src/window/components/`; `WL/` = `src/window/lib/`; `WS/` = `src/window/styles/`; `RF.css` = `node_modules/@xyflow/react/dist/style.css`. e2e receipts are `name:line` for `e2e/scenarios/name.spec.ts`. "Not read" marks what I did not open.

Versions: `@xyflow/react` 12.11.2 (`package.json:133`), React 19.2.6 (`:146`), `@legendapp/state` 3.0.0-beta.47 (`:112`), Electron 43.8.4 (`:135`), Playwright 1.61.1 (`:119`), vitest 4.1.11 (`:160`).

## Headlines

- The minimap and the whole bottom bar are children of `<ReactFlow>` (an RF `Panel`) so the RF store resolves (`Canvas.tsx:1913-1916`, `FM:45`). The minimap takes geometry from `nodeLookup` and the camera from `transform` (`FM:195-197, 241-253`). It draws no wires.
- Several derived signals exist only while DOM cards are mounted: seat urgency is published from a `useEffect` inside `AgentSeat` (`WC/nodes/AgentSeat.tsx:47-55`), seat clusters read ring state from card DOM (`WC/SeatClusterLayer.tsx:120-142`), and level-of-detail scales are written by querying card DOM (`WL/canvas-tier.ts:153-161, 178-188`).
- Region rollups reach `state$` only through an `observe` inside `RtsBottomBar` (`WC/rts/RtsBottomBar.tsx:566-583`).
- Flags: a tiered feature catalog with live readers exists (`WL/experimental-features.ts:21-22`). I found no existing swap of one whole component for another by a runtime setting.
- Possible rule conflict for the operator: `docs/state-architecture.md:251-252` forbids "feature flags, or rollback instructions that keep an obsolete path alive". The list it sits in is storage law; whether it reaches a renderer flag is not stated in what I read.
- Tests: 46 of 51 e2e specs depend on React Flow DOM classes or test ids, only two harness files centralise card lookup, there are 0 screenshot assertions, and no canvas frame budget gates anything.
- `settings.canvas.showMinimap` and `settings.canvas.fitOnOpen` are declared and persisted but nothing in `src/` reads them by name (`src/shared/settings.ts:99-100, 947-948, 1175-1176` are the only hits).
- The two docs named in the brief cover other topics: `docs/state-architecture.md` is SQLite storage law, `docs/overlay.md` is the build-time premium overlay (`docs/overlay.md:1-9`).

---

## 1. Minimap

File: `FM` (479 lines, read in full). Mounted by `RtsMinimapStack` (`Canvas.tsx:1326-1420`), held as the constant element `MINIMAP_STACK` (`Canvas.tsx:1521-1537`), passed as the `minimap` prop of `RtsBottomBar` (`WC/rts/RtsBottomBar.tsx:562, 594-599`).

| Aspect | What is there | Receipt |
|---|---|---|
| Origin | In-house SVG that replaced RF `<MiniMap>`, which re-rendered per viewport change (about 45% of pan main-thread cost). Rects are React state, the camera is applied imperatively | `FM:7-46` |
| Cards | One `<rect>` per RF node, skipping hidden and zero-size nodes | `FM:241-253, 417-436` |
| Regions | Ordinary rects in the same loop; `REGION_FILL_ALPHA = 0.3`, `STALE_REGION_FILL_ALPHA = 0.16` | `WL/minimap-seat-colors.ts:33-34` |
| Seats | Circles, `r = max(min(w,h)/2, (urgency ? 3 : 2.2) * unit)`, `strokeWidth: 0.8 * unit`; `SEAT_DOT_PX = 2.2`, `URGENT_DOT_PX = 3` | `FM:83-84, 437-450` |
| Wires | None drawn; the file reads no edges | `FM:1-479` |
| Viewport frame | A mask path over everything outside the camera; colour `withAlpha(ground, 0.72)` | `FM:133-134, 451`; `Canvas.tsx:1404-1419` |
| Urgency | `data-urgency` on seat circles sets the stroke; pings are HTML elements, only for `blocked` and `needs-you` (SVG pings cost 2549 layouts in 29.5 s) | `WC/factory-minimap.css:20-22`; `FM:453-476`; `FM:7-46` |
| Ping motion | `juntoMinimapPingBlocked 1.44s linear infinite`; `juntoMinimapPingNeedsYou 2.88s cubic-bezier(0.2, 0.6, 0.4, 1) infinite`; stopped under `html[data-surface-motion="paused"]` and `.react-flow__minimap[data-unseen]` | `WC/factory-minimap.css:44-62` |
| Colours | `minimapNodeColors`; `STALE_FILL_ALPHA = 0.45`, `QUIET_SEAT_FILL_ALPHA = 0.7` | `WL/minimap-seat-colors.ts:31, 42, 47-67` |
| Props | `nodeColor`, `nodeStrokeColor`, `seatMarkOf`, `nodeStrokeWidth` (default 2, passed 1.5), `nodeBorderRadius` (default 5), `maskColor`, `onClick`, `onNodeClick`, `ariaLabel`, `style` | `FM:86-98, 159-160`; `Canvas.tsx:1404-1419` |
| Inputs from stores | `state$.regionSeverityByNodeId`, `useCanvas`, theme, `useSeatRollups()`, a key over `seatUrgency$`, `miniMapSeatMark` | `Canvas.tsx:1328-1359`; `WL/minimap-seat-colors.ts:105-149, 184-203` |
| Click | `rf.setCenter(x, y, { zoom, duration: 240 })` | `Canvas.tsx:1367-1391` |
| Double click | `dt < 320` and within `40` flow units: zoom `Math.min(Math.max(zoom * 1.55, 0.35), 1.6)`, `duration: 280` | `Canvas.tsx:1367-1391` |
| Click a rect or circle | `selectNode` and `state$.focusNodeId.set` | `FM:391-400`; `Canvas.tsx:1393-1399` |
| Drag | Pans with `panZoom.setViewportConstrained(...)`, `moveScale = viewScaleOf() * Math.max(zoom, Math.log(zoom))`; `CLICK_SLOP_PX = 3` | `FM:103, 343-362` |
| Wheel | `panZoom.scaleTo(transform[2] * Math.pow(2, pinchDelta * factor))`; `factor = ctrlKey && Mac ? 10 : 1`; `pinchDelta = -deltaY * (deltaMode === 1 ? 0.05 : deltaMode ? 1 : 0.002)` | `FM:374-381` |
| Screen to flow point | `getScreenCTM().inverse()` | `FM:321-327, 382-390` |
| When it shows | Always while the canvas is mounted. No rule hides it at a breakpoint in what I read; at `max-width: 900px` the bar becomes one column with `max-height: 45vh; overflow: auto` | `Rts.css:678-696` |
| Setting | `canvas.showMinimap` exists (default `false`) with no reader | `src/shared/settings.ts:99, 1175` |

How it gets geometry and the camera from React Flow:

- `useStoreApi()` (`FM:167`).
- Geometry: `nodeLookup.values()`, per node `internals.userNode`, size `measured.width ?? user.width ?? 0`, position `internals.positionAbsolute` (`FM:241-253`). Default element size `{ width: 200, height: 150 }` (`FM:181`).
- Rebuild trigger: store subscriptions on `state.nodes` and `state.nodeLookup` (`FM:267-274`); `sameRects` keeps React state when nothing changed (`FM:58-77`).
- Camera: `store.getState().transform` plus `width` and `height` (`FM:195-197`); a subscription on transform and size coalesced by `requestAnimationFrame` (`FM:279-298`); a `ResizeObserver` (`FM:299-309`).
- View box and frame: `viewBoxFor` (`FM:121-131`), `OFFSET_SCALE = 5` (`FM:101`), `maskPath` (`FM:133-134`), `pingLayerTransform` (`FM:146-153`), unit threshold `> 0.02` (`FM:222`).
- Camera writes go through RF `panZoom` (`FM:343-381`) and `useReactFlow().setCenter` (`Canvas.tsx:1327, 1367-1391`).

DOM and placement:

- Root is `div.react-flow__panel.react-flow__minimap.bottom.right`, `data-testid="rf__minimap"`, `ref={unseenRef}` (`FM:404`); the motion-law test locks that exact string (`tests/motion-law.test.ts:209-211`).
- CSS overrides pin the RF panel into the bar: `z-index: 1 !important; transform: none !important` (`Rts.css:597-617`); svg `clip-path: inset(0 round 8px)` (`Rts.css:619-623`), with a comment "GPU time 24 to 45 ms/s down to 0" (`Rts.css:588-595`); `will-change: transform` (`styles.css:1584-1591`).
- Next to it: `FieldControls`, RF `<Controls showFitView={false} showInteractive={false}>` with a "Fit readable view" button (`Canvas.tsx:1315-1324`), `z-index: 2 !important` (`Rts.css:625-640`).
- Unit tests: `tests/minimap-pings.test.tsx:44-51, 56, 68, 84`; `tests/minimap-same-rects.test.ts:13-37`; `tests/canvas-window-native-readers.test.tsx:48-58`.

---

## 2. Magnifier

File: `MAG` (511 lines, read in full), CSS `WC/CanvasMagnifier.css`.

| Aspect | What is there | Receipt |
|---|---|---|
| Purpose | A loupe shown while Alt is held over the canvas: a schematic "field scan" of what is under the pointer; readout label `field scan - 0.8×` | `MAG:432-485, 498` |
| Constants | `LENS_SIZE = 312`, `LENS_RADIUS = LENS_SIZE / 2`, `CONTENT_RADIUS = LENS_RADIUS - 18`, `INSPECTION_SCALE = 0.78`, `MAX_VISIBLE_NODES = 64` | `MAG:15-19` |
| Rendering | Canvas 2D into a `<canvas>` portalled into the `.react-flow` root; dpr `Math.min(window.devicePixelRatio || 1, 1.5)` | `MAG:311-313, 322, 487-509` |
| Draws | Field and vignette; wires as 1px lines at alpha 0.6, centre to centre; nodes as rounded rects with title, kind, severity; ring, ticks, crosshair | `MAG:118-144, 146-170, 172-230, 232-288` |
| Severity | `node.data.blocked` or `state$.regionSeverityByNodeId.peek()[node.id]` | `MAG:40-44` |
| Theme | `themeFor(themeMode$.peek())` | `MAG:22` |
| Follow | Easing `0.34`; readout flips side at `current.x > root.clientWidth - 280` | `MAG:370, 378` |
| Inputs | Window `pointermove`, `keydown` and `keyup` for Alt, `blur`, `visibilitychange`; gated by `isOperatorTyping` | `MAG:432-485` |
| Interaction | None of its own: `pointer-events: none`, `aria-hidden`, `data-testid="canvas-magnifier"`, `data-active`, `data-readout-side` | `MAG:487-495` |
| Layer | `z-index: 1002`, comment "Above React Flow's selected-node/connection plane (1001), below Junto focus surfaces (10000)" | `WC/CanvasMagnifier.css:7-9` |
| Size and motion | `312px`; position by `--magnifier-x/y` minus `156px`; `opacity 140ms ease-out, scale 180ms cubic-bezier(0.22, 1, 0.36, 1)`; reduced motion `opacity 80ms linear` | `WC/CanvasMagnifier.css:14-24, 101-105` |
| Readout box | `top: 32px; left: calc(100% - 30px); width: 132px` | `WC/CanvasMagnifier.css:40-45` |

Coupling to React Flow:

- Hooks: `useReactFlow` (`MAG:296`), `rf.screenToFlowPosition` (`MAG:339`), `rf.getNodes()` (`MAG:343`), `rf.getEdges()` (`MAG:344`), `useOnViewportChange({ onChange, onEnd })` (`MAG:419-422`).
- Node bounds: `node.measured?.width ?? node.width ?? Number(node.style?.width ?? 0)` and `node.position` (`MAG:46-55`).
- DOM: the pointer target must be inside `.react-flow__pane, .react-flow__node, .react-flow__edge` (`MAG:290-293`); `.closest(".react-flow")` at `MAG:312, 319, 377, 405, 434`.
- Side effect: sets `root.dataset.wires = "shown"` while active (`MAG:403-409`), which CSS uses to show wires (`WS/factory-grammar.css:214, 225, 231`).
- Mounted as a child of `<ReactFlow>` under `CountedSurface id="magnifier"` (`Canvas.tsx:1896-1898`).

---

## 3. The canvas in the app

### Mount tree

```
src/window/main.tsx
  import "@xyflow/react/dist/style.css"                              main.tsx:4
  <StrictMode><WindowRuntimeContext.Provider><LiveSeatViewSource>    main.tsx:225-233
    [<Profiler id="root"> when PERF_ENABLED]                         main.tsx:234-247
    AppRoot (hash routes to galleries first, :118-137)               main.tsx:109
      <RendererErrorBoundary title="This window hit a render error"><App/>   main.tsx:192-196
App.tsx
  div.junto-app.flex.h-screen.w-screen.flex-col.overflow-hidden      :596
    CountedSurface "top-bar" > TopBar                                :597-603
    div.junto-stage.flex.min-h-0.flex-1                              :605
      div.junto-stage-main.relative.min-w-0.flex-1                   :607  (the stage's only child, :605-686)
        AuthorityBanner, error banner, boot indicator                :608-632
        <ReactFlowProvider><Canvas/><DemoCameraBridge/></ReactFlowProvider>   :634-637
        CanvasChrome, FocusSwitcherHud, LiveConversationHost         :638-644
        WorkFocusShell, PersistentTerminalHost, TerminalGridFocus    :647-662
        SettingsPanel, DigestPanel, DesktopNotificationsHost,
        StoreHost, AgentEditorHost, ObservabilityPanel               :663-670
        MachinesWindow (lazy, mounted only while open)               :672-682
        DemoLayer, FirstRunIntro                                     :683-684
    ConfirmHost, UnsavedFilesHost, OperatorModalHost, TooltipLayer   :687-690
Canvas.tsx
  Canvas() = <div className="h-full w-full"><CanvasGraph/></div>     :1935-1937
  CanvasGraph: CanvasPerformanceBoundary (Profiler "canvas", :1539-1553), fragment :1819-1932
    TerminalWizard, GitWizard, FilesWizard (before <ReactFlow>)
    <ReactFlow ...>                                                  :1823-1885
      CanvasLoom, WirePulseFeed, CanvasMagnifier, CanvasKeyboardPan,
      RegionGlanceGate, CanvasTierGate, SeatClusterLayer,
      RegionUrgencyGate, ImpactSeedChip, Panel(bottom bar)           :1890-1916
    ContextModeDeck, MultiSelectMenu, SeatMenu, SquadDialogHost,
    ProfileDialogHost, ProfileDraftEditorHost, TargetConnectMenu     :1918-1931
```

- Providers above the canvas: `StrictMode`, `WindowRuntimeContext.Provider`, `LiveSeatViewSource` (theme, tier, portraits through `SeatViewSourceProvider`; `WC/LiveSeatViewSource.tsx:22-41`, `WC/seat-view-source.tsx:34-58`), `RendererErrorBoundary`, `ReactFlowProvider`. No store provider: the Legend-State observables are module singletons.
- `ReactFlowProvider` wraps only `<Canvas />` and `<DemoCameraBridge />` (`App.tsx:634-637`). Everything else in the app is outside it and cannot use RF hooks.
- The comment at `App.tsx:606` says "Canvas column shrinks when the dock opens", but the stage has no second child in the JSX (`App.tsx:605-686`). The dock lives in `WorkFocusShell` (internals not read).
- `main.tsx` also calls `refuseAnimationIterationListeners()` (`:22-26`) and `startCanvasPerformanceHarness` (`:224`), and has a dev opt-in `localStorage "junto:react-scan"` with the note "heavy on React Flow canvases" (`:28-36`).

### `<ReactFlow>` props that carry behaviour (`Canvas.tsx:1823-1885`)

`connectionMode={ConnectionMode.Loose}`, `connectionRadius={42}`, `panOnScroll`, `panOnScrollSpeed={1.2}`, `panOnDrag={[1]}`, `panActivationKeyCode={null}` (`:1849-1853`); `selectionOnDrag`, `selectionMode={SelectionMode.Partial}`, `multiSelectionKeyCode="Shift"`, `selectionKeyCode={null}` (`:1859-1866`); `zoomOnDoubleClick={false}`, `deleteKeyCode={CANVAS_DELETE_KEY_CODE}` (`:1868-1877`); `elevateNodesOnSelect={false}`, `elevateEdgesOnSelect={false}`, `minZoom={0.15}`, `maxZoom={2.5}`, `proOptions={{ hideAttribution: true }}`, `style={{ background: fieldTheme.ground }}`; class names `is-connecting`, `impact-mode`, `connection-focus-mode` (`:1824-1827`). No `<Background>`, by decision (`:1886-1889`).

### Stacking facts

- Tokens (`WS/layers.css`): `--layer-base: 0` (`:18`), `--layer-canvas-track: 1000` (`:23`), `--layer-working: 10000`, `--layer-working-dialog: 11000`, `--layer-popover: 12000`, `--layer-flyout: 13000`, `--layer-operator: 15000`, `--layer-operator-dialog: 15500`, `--layer-operator-popover: 16000`, `--layer-tooltip: 20000` (`:25-39`).
- Rule: a z-index of 100 or more must be a token (`AGENTS.md:388`; `scripts/lint-layers.ts:24` `LAYER_FLOOR = 100`). Three canvas files are exempt by name: `canvas-lod.css`, `preamble-bubble.css`, `CanvasMagnifier.css` (`scripts/lint-layers.ts:29-33`).
- RF defaults: `.react-flow__pane` 1 (`RF.css:111`), `.react-flow__viewport` 2 (`:125`), `.react-flow__renderer` 4 (`:129`), `.react-flow__selection` 6 (`:132`), `.react-flow__panel` 5 (`:293`), `svg.react-flow__connectionline` 1001 (`:207`). The node toolbar's z-index is not in the stylesheet: not read.
- `--layer-canvas-track` is documented as inside the viewport's own stacking context: above every card (32), under a hovered far seat (2000) and seat clusters (3000) (`WS/layers.css:19-22`).
- `.junto-stage { isolation: isolate }` (`styles.css:55-56`); `--bar-height: 64px` (`styles.css:49`).

### Inventory: what is drawn over or beside the canvas

| Item | Where | Layer or z | Space | How it is placed or follows |
|---|---|---|---|---|
| Top bar `header.station-bar` (UsageHud, CanvasPicker, CommandBarTrigger, SaveStatus, CommandGroupBar, UpdateChip, QuickCaptureButton, NeedsYouButton, FactoryPauseControl, help popover, settings) | `App.tsx:597-603`; `WC/TopBar.tsx:278-336` | `z-index: 30` (`styles.css:506-510`) | Screen, beside | Flex row above the stage |
| AuthorityBanner | `App.tsx:608-612` | `z-40` | Screen, over | `absolute left-1/2` in stage-main |
| Error banner | `App.tsx:614-625` | `z-50` | Screen, over | `absolute left-1/2 top-3` |
| Boot indicator | `App.tsx:627-632` | `z-40` | Screen, over | `absolute left-1/2 top-5` |
| CanvasChrome (only `CanvasEmpty`) | `App.tsx:638-640`; `WC/CanvasChrome.tsx:5-7, 12, 23-26` | `z-20` | Screen, over | `absolute left-1/2 top-1/2`; shown from `modelStore.canvas$(canvas).nodeIds` |
| FocusSwitcherHud | `App.tsx:641-643`; `styles.css:647-651` | `--layer-operator` | Screen | `position: fixed; inset: 0`, portal |
| WorkFocusShell (workbench, dock) | `App.tsx:653-655`; `WC/workbench/WorkFocusShell.tsx:186-197` | `z-index: 40` through `.focus-surface--contain-parent` (`styles.css:75-81`) | Screen, over | `absolute; inset: 0`, fills stage-main only |
| PersistentTerminalHost, TerminalGridFocus, LiveConversationHost | `App.tsx:644, 656-661` | Not read | Screen | Not read |
| SettingsPanel, DigestPanel, StoreHost, AgentEditorHost, ObservabilityPanel | `App.tsx:663-670` | Not read per component; a default `FocusSurface` is `position: fixed; inset: 0; z-index: var(--layer-working)` (`styles.css:66-73`) | Screen | Shell |
| MachinesWindow fallback `.machines-opening` | `App.tsx:672-682` | `--layer-working` (`styles.css:2897-2900`) | Screen | Fixed |
| ConfirmHost, UnsavedFilesHost | `App.tsx:687-688` | `--layer-working-dialog`, `--layer-operator-dialog` (`WC/ui/dialog.css:7, 15`) | Screen | Dialog shell |
| OperatorModalHost | `App.tsx:689` | `--layer-operator` (`WC/operator-modal/operator-modal.css:8`) | Screen | Shell |
| TooltipLayer | `App.tsx:690` | `--layer-tooltip` (`styles.css:2297`) | Screen | Keeps clear of `.react-flow__node-toolbar` (`WC/TooltipLayer.tsx:35`) |
| Popover, Dropdown, AgentCascadeMenu | `styles.css:2332, 2346`; `WC/ui/Dropdown.tsx:258-259`; `WC/node-palette/AgentCascadeMenu.tsx:804` | `--layer-popover`; `--layer-operator-popover` or `--layer-flyout`; `--layer-flyout` | Screen | Anchored, fixed |
| Bottom bar `.rts-shell` (CommandCard, KindMiddle, minimap slot) | `Canvas.tsx:1913-1916`; `WC/rts/RtsBottomBar.tsx:586-601` | RF panel 5; `.rts-shell` `z-index: 25`; panels `120px` high (`Rts.css:14-41`) | Screen, over | RF `Panel position="bottom-center"`; `.rts-bar-panel` has pointer-events none (`Rts.css:3-8`) |
| Command popover `.rts-cmd-pop` | `Rts.css:80-86` | `z-index: 40` | Screen | `absolute; bottom: calc(100% + 6px)` |
| Minimap | Section 1 | `z-index: 1 !important` in its wrap | Screen | Inside the bar |
| Field controls (RF `Controls`) | `Canvas.tsx:1315-1324` | `z-index: 2 !important` (`Rts.css:625-640`) | Screen | Inside the bar |
| Field tools: "add item" trigger, "Fit all nodes" | `Canvas.tsx:939-1001` | `.rts-field-tools-slot` `z-index: 40`, `top: 5px; left: 5px` (`Rts.css:513-519`); `.node-deck-host` 41 (`:553-556`) | Screen | Inside the bar; new items placed at `rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })` |
| Node palette deck | `Canvas.tsx:906-936` | `[role="dialog"][data-canvas-menu-surface] { z-index: var(--layer-popover) !important; }` (`WC/node-palette/node-palette-mode-deck.css:204`) | Screen | `FocusSurface measure="workspace" height="fit"` |
| ImpactSeedChip | `Canvas.tsx:1477-1504` | RF panel 5 | Screen | RF `Panel position="top-left"` |
| Magnifier | Section 2 | `1002` | Screen | Portal into `.react-flow`; CSS variables from the pointer |
| ContextModeDeck | `Canvas.tsx:1005-1015, 1918` | As the palette deck | Screen | Flow point from `rf.screenToFlowPosition` on the right-click point |
| MultiSelectMenu | `Canvas.tsx:1047, 1196-1197, 1919` | `zIndex: 40` | Screen | `position: fixed`; manual math: `rf.getNodesBounds` plus `rf.flowToScreenPosition` (`:1698-1707`), then `placeBesideRect` or `placeAtPoint` (`:1070`) |
| SeatMenu | `Canvas.tsx:1221, 1250-1251, 1920` | `zIndex: 40` | Screen | `position: fixed`, `placeAtPoint` (`:1234`) |
| TargetConnectMenu | `Canvas.tsx:1264, 1283, 1924-1931` | `zIndex: 40` | Screen | Fixed; `left: Math.min(at.x, window.innerWidth - 210)`, `top: Math.min(at.y, window.innerHeight - 120)` |
| TerminalWizard, GitWizard, FilesWizard, SquadDialogHost, ProfileDialogHost, ProfileDraftEditorHost | `Canvas.tsx:1565-1602, 1921-1923` | Not read | Screen | Wizards open on window events `junto:new-terminal`, `junto:new-git`, `junto:new-files` |
| Cards and regions | `WL/flow-nodes.ts:17-18` | `REGION_Z_BASE = 0`, `CARD_Z = 32` | Canvas | RF node renderer inside `.react-flow__viewport` |
| Node toolbar | `WC/nodes/NodeShell.tsx:168, 227`; `WC/nodes/GroupNode.tsx:55` | Not read | Screen size, follows a node | RF `NodeToolbar isVisible position={Position.Top} offset={8}` |
| Node resizer | `WC/nodes/NodeShell.tsx:493`; `WC/nodes/GroupNode.tsx:354` (`minWidth={320} minHeight={180}`) | Not read | Canvas | RF `NodeResizer` |
| Handles and landing zones | `WC/nodes/NodeShell.tsx:61, 139, 155` | `.junto-handle.junto-verb-zone` 20 (`WS/factory-grammar.css:109-115`); source 3, target 2 (`styles.css:1518-1519`) | Canvas | RF `Handle`, ids `s-<side>` and `t-<side>` |
| Preamble bubble | `WC/nodes/PreambleBubble.tsx:14-30` | `.junto-preamble` 30; `.react-flow__node:has(.junto-preamble) { z-index: 1001 !important; }` (`WC/nodes/preamble-bubble.css:20, 37`) | Canvas, lifted by a screen amount | Manual math: `--pre-lift = (8 + toolbar height + 6) / zoom`, zoom from `useStore(store.transform[2])`, height measured on `.react-flow__node-toolbar[data-id]`, fallback `42` |
| Reach summary | `WS/reach-preview.css:32` | `.react-flow__node[data-reach-summary] { z-index: 33 !important; }` | Canvas | CSS on the card |
| Wire labels | `WC/edges/WireEdge.tsx:138-161` | Not read | Canvas | RF `EdgeLabelRenderer` |
| Flow track, wire pulse | `WC/edges/FlowTrack.tsx:69-101`; `WC/edges/WirePulse.tsx:31-40` | `--layer-canvas-track` (`WC/edges/flow-track.css:17-23`; `WC/edges/wire-pulse.css:13-18`) | Canvas | RF `ViewportPortal` |
| Seat cluster badges | `WC/SeatClusterLayer.tsx:155-160, 283-289` | 3000, hover or focus 3001 (`WS/canvas-lod.css:264-277`) | Canvas position, screen-held size | RF `ViewportPortal`, `translate(x px, y px)`; body scale written by `writeClusterScale` (`WL/canvas-tier.ts:163-170`) |
| Hovered far seat | `WS/canvas-lod.css:173-175` | `2000 !important`; far hit disc `::after` at -1 (`:111-118`) | Canvas | CSS |
| CanvasKeyboardPan, CanvasTierGate, RegionGlanceGate, RegionUrgencyGate | `Canvas.tsx:1899-1909` | None | Nothing drawn | Children of `<ReactFlow>` for store access (section 8) |

- "Pinned tabs" is named as a base-layer member in `AGENTS.md:388`; I found no component for it (a grep for `pin` in `src/window/lib/dock-state.ts` returned nothing). Unverified beyond that grep.
- The comment at `WL/canvas-tier.ts:163` says cluster badges "are outside the viewport", while `SeatClusterLayer` renders through `ViewportPortal` (`WC/SeatClusterLayer.tsx:4, 283-289`). Not reconciled.

---

## 4. State and change flow

### Stores that hold canvas data

| Store | Where | Shape | Canvas use |
|---|---|---|---|
| `modelStore` | `WL/use-model.ts:9`; `WL/model-store.ts:19-33` | Per canvas: `{ status, error, seq, nodes, wires, nodeIds (paint order), wireIds }` | The model. Accessors `canvas$`, `node$`, `wire$` (`WL/model-store.ts:288-292`) |
| `state$` | `WL/state.ts:17-113` | `canvasName`, `fitViewRequest`, `canvasOpenRequest`, `editNodeId`, `selectedNodeId`, `selectedNodeIds` (`:32-34`), `selectedEdgeId`, `connectionFocusNodeId`, `focusNodeId`, `focusNodeIds`, `regionSeverityByNodeId` (`:68`), `regionCountsByNodeId` (`:70`), `actorRefs` (`:73`), `docVersion` (`:76`), `docEpoch` (`:79`), `settings` (`:83`), `nodePaletteOpen` | UI state. No viewport field. Comment: "React Flow keeps its own copy for smooth interaction; `docVersion` steps to re-sync it" (`:14-16`) |
| `kernel$` | `WL/kernel-view.ts:17-25` | `{ execution, executionRev }` | Blocked overlay; bridge `:63-93` |
| `agentSeat$` | `WL/agent-seat-state.ts:65-72` | `{ byBindingId, bindingIdByNodeId, needsLookByBindingId, doneAtByBindingId, hydrated, rev }` | Seat activity |
| `terminal$` | Read at `WC/nodes/SeatCard.tsx:47-56` | `sessionByBindingId` (rest not read) | Seat session |
| `seatTasks$`, `canvasTasks$` | `WL/seat-tasks.ts:15, 21` | Task index by seat | Card facts and rebuild trigger |
| `seatUrgency$`, `nodeUrgency$`, `regionUrgency$` | `WL/region-urgency.ts:55, 71, 111` | By id, `Urgency` (`:22`) | Minimap, region marks |
| `nodeStatus$`, `nodeSpokenKind$` | `WL/node-status.ts:42, 54` | By node id | Status |
| `canvasTier$`, `cameraSettled$` | `WL/canvas-tier.ts:28-36, 67` | Tier by zoom: `TIER_NEAR_MIN = 0.62`, `TIER_MID_MIN = 0.34`, `TIER_FAR_MIN = 0.2`, `TIER_HYSTERESIS = 0.03`, `CAMERA_SETTLE_MS = 160`, `TIER_ATTR = "data-canvas-tier"` | Level of detail |
| Region rollup store | `WL/region-rollup-store.ts:51-187`; `WL/region-rollups.ts:12, 35, 43-49` | Rollup per region, refcounted `retain` | Bottom bar, minimap, magnifier |
| RF internal store | `useNodesState`, `useEdgesState` in `Canvas.tsx:1422-1474` | RF nodes and edges, `nodeLookup`, `transform` | The copy the canvas draws from |

### How `Opened` and `Changed` are applied

1. `modelStore.open` (`WL/model-store.ts:295-315`) calls `read` (`:214-247`) then `applyOpened` (`:192-212`). `keepUnchanged` keeps the identity of rows that did not change (`:52-71`); `paintOrder` builds `nodeIds` (`:73-76`).
2. `applyChanged` (`:249-268`) ignores `event.seq <= seq`, rereads when `event.seq !== seq + 1`, otherwise `applyRows` (`:157-190`).
3. Optimistic path: `show` applies `rowsAfterCommand` locally (`:91-102, 344-351`), `deliver` sends (`:357-369`), `send` does both (`:372-375`).
4. Wiring: `followStore` (`WL/mutations.ts:61-72`, called at `App.tsx:523`); `dropWhatLeft` steps `docVersion` and `docEpoch` (`WL/mutations.ts:35-58`); a core restart calls `modelStore.rereadOpen()` (`App.tsx:534-543`).
5. Into React Flow: `useCanvasDocument` (`Canvas.tsx:305-473`) observes `modelStore.canvas$(name).nodes` and `.wires` (`:346-351`), `seatTasks$.bySeat` (`:354-357`), `state$.actorRefs` and `kernel$.executionRev` (`:358-359`), then `applyStructuralRebuild` (`:272-303`) runs `toFlowOfCanvas` (`WL/convert.ts:55-66`), `flowNodesFromModel` (`WL/flow-nodes.ts:171-248`), `stampImpactShell` and `keepHeldNodes`. A rebuild is deferred during a drag (`:313-324`).

### How a card reads its node

- A flow node carries only `ModelNodeData = { canvas, id, kind, blocked, regionDepth?, nameSlot?, ringCap?, seatRegion?, homeRegion?, parentRegion? }` (`WL/flow-nodes.ts:23-40`); "a card reads the rest from the node store" (`WL/convert.ts:20-23`).
- Hooks: `useNode` (`WL/use-model.ts:30-31`), `useNodeOf` (`:34-37`), `useNodeValue` (`:43-44`), `useNodeFieldOf` (`:51-57`), `useCanvas` (`:60-66`).
- Examples: `WC/nodes/TextNode.tsx:92-105` (one field per `useNodeValue`); `WC/nodes/NodeShell.tsx:369-384` (kind, color, bindingId, agentKey, overseer); `WC/nodes/SeatCard.tsx:47-56`.
- Render counting: `countRender("text-card", id)` and `countRender("node-shell", id)` (same receipts); the invariant is tested in `tests/card-render-count.test.tsx:112-139`.

### Seat activity: path and rate

| Hop | What | Receipt |
|---|---|---|
| Core | `seatStateRuntime.subscribe` and `remoteState.onState` publish `TERM_SEAT_STATE` (`"term.seatState"`) | `src/core/ops/term-ipc.ts:57-58`; `src/contract/core/channels.ts:106` |
| Main | Broadcasts `IPC_CHANNELS.agentSeatStateChanged` (`"junto:agent-seat-state-changed"`) directly. Other terminal events go through a coalescer; seat state does not | `src/app/term/ipc.ts:275-282`; `src/shared/ipc.ts:393` |
| Preload | `subscribe(IPC_CHANNELS.agentSeatStateChanged, listener)` | `src/window/preload/index.ts:752` |
| Renderer store | `subscribeAgentSeatState` then `applyAgentSeatStateEvent` into `agentSeat$` | `WL/agent-seat-state.ts:233-275, 311-354` |
| Card | `use$(agentSeat$.byBindingId[...])`, `needsLookByBindingId`, `terminal$.sessionByBindingId`; `seatFactsForNode(...)` then `cardMark(facts)`; `<AgentSeat activity=...>` | `WC/nodes/SeatCard.tsx:47-56, 88-96, 137-163` |
| Occupancy clue | `useSeatOccupancyClue(bindingId)` | `WL/occupancy-feed.ts:21-24`; `WC/nodes/NodeShell.tsx:384` |

- Rate: the core stream is described as "debounced" (`src/core/term/agent-state/seat-state-machine.ts:3`; interval not read). No renderer-side throttle was found on this path.
- Rates the probes replay: 10 per second (`zz-seat-events-probe:23`, `zz-anim-census:18`) and 30 per second (`zz-zoom-smooth:24`).
- A measured cost is recorded in a comment: "10 reports a second: 2.3 s of style in 8 s, 5,300 rule-change restyles in 6 s" (`WC/SeatClusterLayer.tsx:71-76`).

### Where derived state is computed

| Derived | Computed in | Receipt |
|---|---|---|
| Blocked | `toFlowOfCanvas`: kernel overlay, else `deriveExecutionGraph(canvas, context).blocked`; stamped on node data; cards read `NodeBlockedContext` | `WL/convert.ts:61`; `WL/node-status.ts:66`; `WC/nodes/NodeShell.tsx:463-464` |
| Region membership for drawing | `regionFacts` | `WL/flow-nodes.ts:106-165` |
| Region rollups | Membership observes `nodeIds`, each node's `kind/x/y/width/height`, wires, `regionMembers`; `deriveRegionRollups` per region | `WL/region-rollup-store.ts:51-114, 129-170` |
| Severity and counts by node | An `observe` inside `RtsBottomBar` writes `state$.regionSeverityByNodeId` and `regionCountsByNodeId` when the JSON differs | `WC/rts/RtsBottomBar.tsx:566-583` |
| Seat urgency | Inside the mounted card: `seatUrgencyOfRing(...)` then `publishSeatUrgency(id, urgency)` in `useEffect`, cleared on unmount | `WC/nodes/AgentSeat.tsx:47-55`; `WL/region-urgency.ts:41-63` |
| Node status, node urgency | Inside mounted cards | `WC/nodes/SpineCard.tsx:134, 143`; `WL/use-node-urgency.ts:10-12` |
| Region urgency | `RegionUrgencyGate` reads `nodeLookup.get(id)?.data.seatRegion ?? homeRegion` and `parentRegion`, subscribes to `seatUrgency$`, `nodeUrgency$` and RF `state.nodes` | `WC/RegionUrgencyGate.tsx:26-49`; `WL/region-urgency.ts:85-123` |
| Minimap seat rollups | `seatRollupsForCanvas`, `useSeatRollups` | `WL/minimap-seat-colors.ts:105-149, 184-203` |
| Tier and camera rest | `CanvasTierGate` from the RF store transform | `WC/CanvasTierGate.tsx:38-70` |
| Seat clusters | `readSeats` reads rings from card DOM and positions from `nodeLookup` | `WC/SeatClusterLayer.tsx:120-142` |

### App to canvas commands, and the camera

- `state$.fitViewRequest` runs `fitReadableField` (padding 0.18, duration 320, `maxZoom` 1.15 with regions else 1.35) (`Canvas.tsx:164-174, 1422-1474`).
- `canvasZoomRequest$` runs `rf.zoomIn({ duration: 160 })`, `zoomOut`, `zoomTo(1, { duration: 200 })` (`Canvas.tsx:1452-1464`; defining module not read).
- `state$.focusNodeId` runs `rf.fitView({ nodes: [node], padding: 0.35, maxZoom: 1.45, duration: 360 })`, retried for up to 12 frames (`Canvas.tsx:475-513`); group focus waits up to 24 frames for `measured` (`WC/useCanvasGroupFocus.ts:24-52`).
- The camera is not persisted: no viewport in `state$` (`WL/state.ts:17-113`), and a grep for `viewport` in `WL/view-state.ts` returned nothing (header `:1-40` read). The opening camera is computed once by `openingViewport` (`WL/camera-placement.ts:20-24, 58`; `PADDING = 0.18`, `FIRST_CLUSTER = 24`) and applied with `rf.setViewport` (`Canvas.tsx:515-536`).

### Rules a new component must follow

`docs/state-architecture.md` (277 lines) is storage law. What it says that reaches a renderer component:

- "There is no canvas document"; nothing reads, writes, compares or hashes a canvas as one value (`docs/state-architecture.md:171-179`). Gate: `lint:no-canvas-document --enforce` (`scripts/verify.ts:59`).
- A renderer never opens the database (`docs/state-architecture.md:242`).
- Forbidden: "file-store importers, compatibility readers, dual writes, feature flags, or rollback instructions that keep an obsolete path alive" (`docs/state-architecture.md:251-252`). Related storage-scoped wording: `AGENTS.md:83-84` and `AGENTS.md:444-446`.

The renderer rules are in `AGENTS.md`:

- `Changed`: "A listener applies it and does not read again. `Opened` is the one read" (`AGENTS.md:243-245`).
- Live work is never on a node (`AGENTS.md:247-249`).
- "thousands of mails between hundreds of seats must not cost it a frame, and one command must change one row" (`AGENTS.md:251-252`).
- Stoppage is derived, not authored (`AGENTS.md:270`); derived state is recomputed from the model and live work (`AGENTS.md:274-276`).
- "Retain Legend State v3" (`AGENTS.md:97-98`).
- Motion law (`AGENTS.md:295-316`), canvas card law (`:383`), focus law (`:386`), layers (`:388`), shells (`:389`).
- No test waits on a real clock (`AGENTS.md:471-473`); `bun run typecheck && bun run test` gate every change (`:457`).

---

## 5. Settings and flags

### How a setting is declared, persisted and read

| Step | Where |
|---|---|
| Schema: `Settings` struct with sections; `SETTINGS_VERSION = 1` | `src/shared/settings.ts:34, 886-929` |
| Example section: `CanvasSettings = { defaultCanvas, showMinimap, fitOnOpen }`; patch fields; defaults | `src/shared/settings.ts:96-101, 947-948, 1173-1177` |
| Stored as one row `settings_preferences(singleton, version, body, updated_at)` | `src/core/settings/service.ts:123-140` |
| After commit, core publishes; main broadcasts `settingsChanged` to every window | `src/core/settings/service.ts:358-373`; `src/app/settings/ipc.ts:156-161` |
| Preload: `settingsGet`, `settingsPatch`, `onSettingsChanged` | `src/window/preload/index.ts:553-555, 578` |
| Renderer: `startSettingsBridge` fills `state$.settings`; `patchSettings` writes | `WL/settings-state.ts:13-45, 67-85` |
| Read: `use$(state$.settings...)` in components, `.peek()` or `.get()` elsewhere | `WL/experimental-features.ts:17-22` |

### Experimental features (the existing opt-in mechanism)

- Tier type: `FeatureTier = boolean | "experimental"` (`src/shared/feature-catalog.ts:206`). A catalog entry is `{ env, define, experimental?: { title, description, requirement?, applies: "live" or "restart" } }` (`:108-136, 211-218`).
- Current experimental entries: `seatAwareness` (`applies: "live"`, requires `TYPESAFE_API_KEY`, `:108-121`) and `files` (`applies: "live"`, `:127-136`). Ship tiers: `seatAwareness: "experimental"` (`:257`), `files: true` (`:259`), `devTools: false` (`:255`).
- Build: per-feature env takes `0`, `1` or `experimental` (`scripts/build-features.ts:34-36`); profile `JUNTO_FEATURE_PROFILE` is `ship` or `all-on` (`:19-22`); `experimental` is refused for a key with no catalog entry, "has no Settings toggle" (`:45-48, 88`).
- Compile-time side: `declare const __JUNTO_*` (`src/shared/features.ts:20-43`), a tier constant (for example `FILES_TIER`, `:224-227`), an entry in `BUILD_FEATURES` (`:271-296`).
- Opt-in storage: `settings.advanced.experimental`, a record capped by `EXPERIMENTAL_OPT_INS_MAX = 64` (`src/shared/settings.ts:123-135, 169`), merged key by key (`:1509-1513`), kept across a reset of `advanced` (`src/core/settings/service.ts:590-595`). Whether keys are validated against the catalog: not read.
- Resolution: `featureOn(key, optIns)` (`src/shared/features.ts:312-315`).
- Renderer readers: `featureOnNow` (`WL/experimental-features.ts:17-18`), `useFeatureOn` (`:21-22`), `setExperimentalFeature` (`:44-45`).
- Settings UI: the Experimental section appears only when `experimentalFeatureKeys().length > 0` (`WC/SettingsPanel.tsx:126-136`); rows are generated from the catalog, each a `Switch`, and show "Applies after you restart Junto." when `applies` is not `"live"` (`WC/settings/ExperimentalSettingsSection.tsx:61-104`).
- Developer gates: `DEV_TOOLS_ENABLED` (`src/shared/features.ts:116-118`), used in Advanced settings (`WC/SettingsPanel.tsx:589, 657, 678, 686, 694, 698`).

### Adding a boolean that swaps one component for another

What the `files` key touches, as the only worked example of a tiered key: the catalog entry (`src/shared/feature-catalog.ts:127-136`), the ship and all-on tiers (`:244-305`), and `declare const`, tier constant and `BUILD_FEATURES` entry (`src/shared/features.ts:38, 224-230, 290`). The settings row and persistence need no further code. The other route is a plain field in a settings section (schema, patch schema and default, as `showMinimap` shows).

### Does a flip take effect live?

- Yes for readers that use `useFeatureOn`: the value is a `use$` over `state$.settings.advanced.experimental` (`WL/experimental-features.ts:21-22`), and settings changes are broadcast to the window after commit.
- Existing live readers: `Canvas.tsx:1593`; `WC/node-palette/NodePaletteModeDeck.tsx:107`; `WC/files/FilesWizard.tsx:30`; `WC/files/FilesCard.tsx:83`; `WC/nodes/TextNode.tsx:241`; `WL/seat-awareness.ts:358, 371, 382, 392` (starts and stops hydration on toggle).
- No existing example of a whole-component swap by a runtime setting was found. The nearest are compile-time or URL swaps: `MachinesWindow` lazy under `__JUNTO_FLEET_UI_ENABLED__` (`App.tsx:76-81`), and hash-routed galleries that replace the app root (`src/window/main.tsx:63-105, 118-137`).
- A swap of `<Canvas />` would unmount `ReactFlowProvider` state: the RF camera is not stored anywhere else (section 4).
- e2e has no settings seed option. Scenarios patch at run time with `window.junto!.settingsPatch(...)` (`artifacts-milestone:51`), and the harness patches `advanced.onboardingSeen` (`e2e/harness/launch.ts:621-623`). No e2e sets `advanced.experimental`.

### Developer switches outside settings

- `JUNTO_PERF`: resolved from `globalThis.JUNTO_PERF`, the URL, `localStorage["JUNTO_PERF"]`, then `process.env.JUNTO_PERF`; frozen at module load as `PERF_ENABLED` (`WL/performance/perf-flag.ts:1-89`).
- `window.juntoSurfaceCommits`, `window.juntoCardRenders`, `CountedSurface`, `countRender` (`WL/performance/surface-commits.tsx`); `juntoPerf.report()`, `PERF_LOG_PREFIX = "[junto-perf]"`, `PERF_REPORT_INTERVAL_MS = 5_000` (`WL/performance/perf-harness.ts:32-34`).

---

## 6. Tests

### (a) Unit tests that import or mock `@xyflow/react`

| File | What it tests |
|---|---|
| `tests/minimap-pings.test.tsx:17, 44-51` | Mounts `<ReactFlowProvider initialNodes>` with `FactoryMinimap`; pings are HTML, keyframes are compositor-only, `pingLayerTransform` |
| `tests/page-card-native-reader.test.tsx:2, 13-33` | Mounts `<ReactFlow nodeTypes={{ link: LinkNode }}>`; card text comes from the store |
| `tests/canvas-window-native-readers.test.tsx:2, 48-58` | Mounts `<ReactFlowProvider><Canvas /></ReactFlowProvider>` in jsdom; asserts `[data-id="memo"]`, `[data-id="planner"]`, text, and that a note edit opens the dock |
| `tests/card-render-count.test.tsx:26, 112-139` | A card renders only when its own node changed |
| `tests/canvas-camera-rest.test.tsx:46, 84-86, 160-319` | `vi.mock("@xyflow/react", () => ({ useStoreApi: () => camera }))`; LOD custom properties wait for camera rest; builds `.react-flow__viewport` and `.react-flow__node` DOM by hand |
| `tests/renderer-boot-graph.test.ts:61` | `expect(packages.has("@xyflow/react")).toBe(true)`, as proof the import walker reaches window code |
| `tests/kit-purity.test.ts:14` | The kit must not import `@xyflow/` (`FORBIDDEN_PACKAGES`) |

### (b) Unit tests that use `react-flow` selectors or strings

| File | What |
|---|---|
| `tests/motion-law.test.ts:156, 168-177, 182, 210-211, 219` | Source-text locks naming RF classes (see (e)) |
| `tests/viewport-promotion.test.ts:19-33` | No `will-change` on `.react-flow__viewport`; no `data-viewport-busy` in four sheets |
| `tests/canvas-chrome-blur.test.ts:21-27` | No `backdrop-filter` on `.react-flow__controls`, `.node-deck-trigger`, `.rts-field-tools__fit` |
| `tests/modal-hidden.test.tsx:28` | A `.react-flow` element is `aria-hidden` under a non-trapping modal |
| `tests/focus-law-authority.test.ts:35`; `tests/focus-law-classes.test.tsx:25` | `.react-flow__node` as a focus scope |
| `tests/canvas-keyboard-pan.test.ts:82` | Pan is blocked when focus is in a `.react-flow__node` |
| `tests/space-presses-control.test.tsx:18-24` | Space on a control inside a card |
| `tests/canvas-camera-rest.test.tsx:84-86, 194, 210` | As above |

Canvas-adjacent unit tests with no RF string but tied to RF-shaped code (names and sizes only; bodies not read): `flow-identity`, `flow-nodes`, `flow-edges`, `camera-placement`, `canvas-tier`, `loom-invalidation`, `region-depth-projection`, `seat-ring-room`, `seat-cluster-sheet`, `multi-select-toggle`, `multi-select-gesture`, `seat-clusters`, `region-glance`, `wire-loom`, `wire-route`, `wire-pulse*`, `canvas-zoom`, `modal-canvas-keys`, `seat-view-source`, `spine-card`.

### (c) e2e scenarios using `.react-flow__` selectors

Totals: 51 spec files in `e2e/scenarios/`. 39 contain `react-flow` (95 lines) and 2 harness files add 3 lines, 98 in all. 4 more specs use only RF test ids `rf__node-<id>` (`canvas-delete-cancel:18`, `canvas-keyboard-seat:20`, `seat-release:30`, `canvas-delete-after-modal:32`; also `briefings-verify:100`). 3 more reach RF only through a harness helper (the three `files-*` specs). 5 touch neither by this grep: `seat-needs-you`, `terminal-journey`, `command-bar-to-seat`, `onboarding-shell`, `view-state-quit`.

| Group | Lines | Representative receipts |
|---|---|---|
| Canvas ready: `.react-flow` visible | 19 | `free-startup:8, 57`; `seat-message:69, 164`; `crew-mail:102, 321`; `perf-hotkeys:562, 565` |
| Card by id is visible | 13 | `note-focus-surface:17`; `board-targets:59`; `seat-sessions:67`; `core-restart-seats:124` |
| Counts | 9 | `node-palette-mode-deck:109, 116, 150`; `zz-zoom-smooth:81` (`.react-flow__node-group` `toHaveCount(fixture.stats.regions)`); `briefings-verify:141` (`toHaveCount(0)`) |
| Card by text (`hasText`) | 3 | `terminal-absolute-row:40`; `canvas-sqlite-roundtrip:29, 60` |
| Card locator helpers, then click, drag, text or class | 13 | `canvas-undo-redo:57`; `wire-writers:41`; `e2e/harness/files-scenario.ts:56`; `e2e/harness/offboard-panel.ts:14, 33` |
| Open or activate (double click or click) | 15 | `core-restart-seats:132, 210`; `board-targets:63, 76` (`position: { x: 10, y: 10 }`); `note-focus-surface:21` |
| Select | 4 | `seat-message:173` (click), `:174` (shift-click), `:175` (right-click); `space-on-control:21` (`.react-flow__node.selected`) |
| Pane click (hand the keyboard to the canvas, deselect) | 7 | `wire-writers:110`; `canvas-undo-redo:121, 163`; `briefings-verify:114` (`{ x: 1300, y: 700 }`) |
| Position and size (`boundingBox`) | 9 | `seat-message:87, 106` (`.react-flow__node-toolbar`); `zz-zoom-smooth:86`; `perf-hotkeys:904, 916` |
| Camera read from `.react-flow__viewport` transform | 3 | `canvas-undo-redo:36` (settled when unchanged for 30 frames); `zz-zoom-smooth:92, 116` |
| Card inner attribute | 1 | `overseer-offboard-cli:264` (`.junto-node` `data-overseer`) |
| Perf probe style injection and DOM census | 2 | `perf-hotkeys:949` (`.react-flow__node{content-visibility:auto}`), `:964` |

Gestures and other assertions (not all are counted lines above):

- Drag: `canvas-undo-redo:60-70` (card `boundingBox`, `page.mouse.move/down/move({ steps: 12 })/up`), checked against main with `readModelNode` (`:72-76`).
- Connect: `wire-writers:113-131` (handle `.junto-handle--source.junto-handle--right`, drop on a `[data-verb="messages"]` zone inside the target card).
- Keyboard on a card: `canvas-keyboard-seat:20-58` (`.focus()`, `toBeFocused`, outline "solid", `aria-label` "Keyboard seat" then "Keyboard seat, selected", `contextmenu` opens `seat-menu`).
- Selected class through helpers: `canvas-undo-redo:103`.
- Region handle: `briefings-verify:100` (`.region-drag-handle`).
- Zoom and pan input: `page.mouse.wheel` (`zz-artifact-task-probe:437, 444`); CDP `Input.dispatchMouseEvent` `mouseWheel` (`zz-zoom-smooth:88-89`; `perf-hotkeys:906`); tier read from `data-canvas-tier` (`perf-hotkeys`, about `:901`).
- Visual: `toHaveScreenshot` is used 0 times. `page.screenshot` is evidence only (`seat-message:89`; `seat-release:55, 62, 70`).
- Fit by role: `wire-writers:102`; `briefings-verify:98` ("Fit all nodes").

### (d) How e2e seeds a canvas

- `LaunchOptions` (`e2e/harness/launch.ts:93-154`): `demo`, `offline`, `seedModels` (`:98`), `seedAgentSignals` (`:100`), `nestedCanvas { fixture, name?, signals? }` (`:106-110`), `windowContentSize` (`:115`), `afterSeed`, `extraEnv` (`:141`), `electronArgs` (`:148`), `firstRunIntro` (`:153`). There is no settings option.
- `launchJunto` merges `nestedCanvas.fixture.model` into `seedModels` under the default name `"nested"` (`:461-472`) and writes models and signals before boot (`:482-487`; `e2e/harness/sandbox.ts:116, 239`). Fixture wiring is `test.use({ juntoOptions })` giving `{ junto: { app, page, sandbox } }` (`:668-686`).
- Builders (`e2e/harness/model.ts`, 184 lines, read in full): `modelSeat` (240x96), `modelRegion` (900x560), `modelNote` (240x120), `modelTerminal` (260x110), `modelWire`, `modelMessagesWire`, `modelFixture` (stamps `z` by index), `readModelCanvas` (`window.junto.modelOpen`), `readModelNode`, `commandModel` (`window.junto.modelCommand`), `installModelFixture`, `readModelSeat`, `grantOverseer`.
- Nested fixtures (`e2e/harness/nested-canvas-fixture.ts`): presets `nested` (seed 1, 44 regions, about 200 seats), `deep` (seed 2, 63 regions), `max` (seed 3, 138 regions, about 250 seats), `factory-like` (seed 4), `flows` (seed 5) (`:71-157`); `OPERATOR_DISPLAY = { windowContentSize: { width: 1726, height: 1083 }, electronArgs: ["--force-device-scale-factor=2"] }` (`:187-190`); `buildNestedCanvasFixture` (`:344`); `loadFactoryShapeCanvas` (`:598-628`).
- Use: 43 specs use `seedModels`; 4 use `nestedCanvas` (the `zz-` probes); 16 use the crew fixture; 0 use `installModelFixture`; some add at run time with `commandModel` (`canvas-undo-redo:21-29`).
- Config: `workers: 2`, `retries: 0`, `timeout: 90_000`, `trace: "retain-on-failure"`, `screenshot: "only-on-failure"` (`e2e/playwright.config.ts`). `scripts/run-e2e.sh` defaults to `free-startup.spec.ts` and refuses a stale `out/` build.

### (e) What `tests/motion-law.test.ts` locks

Header (`:1-15`): weakening needs the operator's sign-off named in the commit.

| Line | Check |
|---|---|
| `:49` | Every moving ring has `spin` or `pulse` |
| `:56` | Ring keyframes declare only `transform`, `opacity`, `animation-timing-function` |
| `:66` | Parts loop with `animation-iteration-count:infinite`, `animation-delay:var(--mark-t0`, no `steps(`, and `MARK_PHASE_MS % ms === 0` |
| `:79` | Tempo: `RING_MOTION.work.spin.lapMs === 1440`, `RING_FRAME_MS <= 90`, `RING_CYCLE_FRAMES * RING_FRAME_MS <= 2880`, `halt.pulse.ms === 1440`, `dot.pulse.ms === 2880` |
| `:87` | Moving marks carry parts; the rest pose only under `data-surface-motion="paused"` |
| `:97` | No `requestAnimationFrame`, `setInterval`, `setTimeout` in `RING_SOURCES` (`:33-39`); `activity-live.ts` must not exist |
| `:107` | `coversMark` only when a mark is wholly covered |
| `:117` | `ActivityMark.tsx` `showIfSeen` and `syncPhase` source patterns |
| `:126` | `TerminalSurface.tsx`: no ring in an `sr-only` box |
| `:136` | Observers in `ActivityMark.tsx` and `edges/FlowTrack.tsx` use `{ rootMargin: "0px" }`, no `threshold` |
| `:147` | Parked pane spinners stop (`styles.css`) |
| `:153` | Reach preview hidden at overview or in a cluster: a selector containing `.react-flow__viewport .react-flow__node`, plus strings in `SeatClusterLayer.tsx` |
| `:163` | Media spinner rules in `content-media.css` mirror hide rules in `canvas-lod.css` |
| `:180` | Wire pulse hidden at mid, far, overview (`canvas-lod-regions.css`) and `WirePulseFeed.tsx` has `canvasTier$.peek() === "near"` |
| `:189` | Browser tab spinner uses `data-unseen` |
| `:198` | Top bar pulses use `unseenRef` |
| `:209` | Minimap root matches `<div ref={unseenRef} className="react-flow__panel react-flow__minimap`, and the `data-unseen` CSS rule exists |
| `:214` | Reach preview `watchUnseen` in `reach-preview.ts` and CSS |
| `:222` | `AGENTS.md` wording |
| `:233` | `wire-pulse.css` keyframes `wire-pulse-forward` and `wire-pulse-reverse` animate `transform` only, no `stroke-dash` |
| `:243` | No `data-mark-frame`, `dataset.markFrame`, `attention-clock` under `src/window`; no `steps(` in `activity-atlas.ts` or `factory-minimap.css` |

### (f) Perf probes and budgets

There is no budget on canvas frames anywhere. Every canvas probe is an opt-in measurement.

| Probe | Measures | Receipt |
|---|---|---|
| `e2e/scenarios/perf-hotkeys.spec.ts` (1043 lines) | Hotkey and modal latency on a 358-node, 841-wire board: long tasks, Event Timing, rAF gaps, a trace Paint census. "no budgets, no assertions on timing. Skipped unless PERF_HOTKEYS=1" | `:1-19, 550, 552`; trace block about `:880-990`; lines `:140-880` not read |
| `e2e/scenarios/zz-zoom-smooth.spec.ts` (194 lines) | Replays `lab/gpu-canvas/gesture.cjs` through CDP wheel and logs per frame whether `.react-flow__viewport` `style.transform` changed; `PROBE_RATE` 30, `PROBE_HZ` 120; summarised by `lab/gpu-canvas/summarize.cjs`; records `arm: "dom"`; skips without the untracked fixture `zz-idle-probe.factory.json` | `:1-13, 24-31, 50, 59, 113-134, 184, 188` |
| `e2e/scenarios/zz-seat-events-probe.spec.ts` (233 lines) | Seat-state storm from main: `PROBE_RATE` 10, `PROBE_SECONDS` 8, `PROBE_REPS` 3; reports `mainBusyMsPerS`, `tasksOver16PerS`, `tasksOver50`, `worstTaskMs`, `mainFramesPerS`, `presentedPerS`; census of all elements, `.junto-mark__part`, `document.getAnimations()` | `:23, 102, 108-112` |
| `e2e/scenarios/zz-anim-census.spec.ts` (93 lines) | Samples `document.getAnimations()` during a storm | `:18, 51` |
| `e2e/scenarios/zz-artifact-task-probe.spec.ts` (674 lines) | 515 artifacts on 29 nodes, 744 tasks; phases boot, open-art, open-task, writes; only sanity `toBeGreaterThan(0)` | `:588-630` |
| `scripts/probe-canvas-perf.ts` (253 lines) | Attaches over CDP (`JUNTO_CDP_URL`, default `http://127.0.0.1:9229`); selection, pan, idle | `:103-210` |
| `scripts/probe-ring-cost.ts` (1049 lines) | Idle and pan scenarios on a fixed fixture | `:510, 512, 826, 855` |
| `scripts/probe-zoom-sweep.ts` (1639 lines) | Ctrl+wheel sweep across all four tiers | `:656-1151` |
| `scripts/verify-lab-canvas.ts`, `verify-lab-commands.ts`, `verify-lab-drag.ts` | Lab checks that read `.react-flow__node` `style.transform` and `.react-flow__edge` count | `:234-239`; `:90-92, 234`; `:78-322` |

- Budgets that do exist are elsewhere: `MAIN_THREAD_BUDGET_MS` (4 ms, main process, `tests/main-thread-budget.test.ts`), SQL writes (`tests/state-write-budget.test.ts`), the main chunk 8 MiB audit (`tests/renderer-boot-graph.test.ts:5-6`). Bodies not read.
- GPU lab: `lab/gpu-canvas/` (README read in full) is "A spike, not product code": 441 nodes, 931 wires, one render pass with four instanced pipelines, modes `view`, `window`, `frame`, `worker`, `main`, no selection, drag, editing or minimap. Its comparison number is dropped frames.
- `docs/canvas-gpu-spike.md` (untracked, another agent's; lines 1-60 read) says "Status: closed" and names `canvas-gpu-architecture.md` and `canvas-gpu-plan.md`, neither of which was in `docs/` when I listed it.
- `PERF_LEDGER.md` (103 lines, dated 2026-09-01) records F1 RF `<Background>` re-render per transform, F2 accessibility tree re-serialised per pan frame, F3 "1120 of them are `div.react-flow__handle` (8 per card)".

---

## 7. What a canvas without DOM cards breaks in tests

Facts the suites take from the DOM today; each needs another source if cards are not elements:

| Fact read | Selector today | Used by |
|---|---|---|
| Canvas mounted and ready | `.react-flow` visible | 19 lines, for example `free-startup:8` |
| A card exists, by id | `.react-flow__node[data-id]`, `rf__node-<id>` | 13 visibility lines plus 5 test-id lines |
| Card and region counts | `.react-flow__node`, `.react-flow__node-group` | 9 lines; all four `zz-` probes wait on the region count |
| Card text | `hasText`, text inside the card | `canvas-sqlite-roundtrip:29, 60`; unit `tests/canvas-window-native-readers.test.tsx:48-58` |
| Card screen box | `boundingBox()` | Drag (`canvas-undo-redo:60-70`), toolbar position (`seat-message:87, 106`) |
| Click, double click, right-click, shift-click on a card | Locator actions | 15 open lines, 4 select lines |
| Selected state | `.selected` class, `aria-label` suffix ", selected" | `space-on-control:21`; `canvas-undo-redo:103`; `canvas-keyboard-seat:20-58` |
| Keyboard focus on a card | `.focus()`, `toBeFocused`, outline style | `canvas-keyboard-seat:20-58`; unit focus-law tests |
| Empty canvas to click | `.react-flow__pane` | 7 lines |
| Camera | `.react-flow__viewport` transform | `canvas-undo-redo:36`; `zz-zoom-smooth:92, 116` |
| Connect handles and drop zones | `.junto-handle--source.junto-handle--right`, `[data-verb]` | `wire-writers:113-131` |
| Region drag handle | `.region-drag-handle` | `briefings-verify:100` |
| Inner card attributes | `.junto-node[data-overseer]` | `overseer-offboard-cli:264` |
| Tier | `data-canvas-tier` on `<html>` | `perf-hotkeys` about `:901` (not an RF selector; survives) |
| Model truth | `window.junto.modelOpen` through `readModelCanvas` | `canvas-undo-redo:72-76` (no DOM; survives) |

Helpers that centralise canvas lookups:

- `e2e/harness/files-scenario.ts:56` (`filesCard`, used by `openFilesModal` `:59-65`); importers `files-drafts-quit:14`, `files-modal-verify:16`, `files-save-scope:15`.
- `e2e/harness/offboard-panel.ts:14, 33` (`offboardNowBlockOf`, `offboardNowFromPanel`); importer `seat-next-launch:16`.

Tests that bypass them:

- Local `card()` helpers: `canvas-undo-redo:57`, `wire-writers:41`, `space-on-control:18`, `seat-next-launch:38`.
- `seat-offboard-modes:67-79` duplicates the offboard helper.
- Every other spec in the 39 writes `page.locator('.react-flow__node[data-id="..."]')` inline.
- There is no shared helper for "canvas ready", "pane", "camera" or "region count".

Unit side:

- Four tests mount real React Flow in jsdom: `canvas-window-native-readers`, `page-card-native-reader`, `card-render-count`, `minimap-pings`. The first stubs `HTMLCanvasElement.getContext` to null, `ResizeObserver`, `matchMedia` and rAF.
- Source-text locks name RF classes or the package: `tests/motion-law.test.ts:153-161, 209-211`; `tests/viewport-promotion.test.ts:19-33`; `tests/canvas-chrome-blur.test.ts:21-27`; `tests/renderer-boot-graph.test.ts:61` (requires `@xyflow/react` in the boot graph).

---

## 8. Anything surprising

### Every site outside `Canvas.tsx` where app code reaches into React Flow

| File | Reach-in |
|---|---|
| `App.tsx:4, 634-637` | `ReactFlowProvider` |
| `src/window/main.tsx:4` | RF stylesheet |
| `FM:2, 167` | `useStoreApi`: `nodeLookup`, `nodes`, `transform`, `width`, `height`, `panZoom` (12 store reads) |
| `MAG:3` | `useReactFlow`, `useOnViewportChange`; six `.react-flow` DOM lookups |
| `WC/CanvasKeyboardPan.tsx:2, 20, 54-61` | `rf.getViewport()` and `rf.setViewport()` per frame |
| `WC/CanvasTierGate.tsx:2, 38` | `useStoreApi`, subscribes to the transform directly (11 store reads) |
| `WC/RegionGlanceGate.tsx:2, 31-35` | `publishRegionGlance(store.getState().domNode, transform[2])` on `cameraSettled$` |
| `WC/RegionUrgencyGate.tsx:2, 26-49` | `nodeLookup`, `state.nodes` subscription |
| `WC/SeatClusterLayer.tsx:4` | `useReactFlow`, `useStoreApi`, `ViewportPortal`; a generated `<style id="junto-seat-clusters">` hiding `.react-flow__node[data-id="..."]` (`:43-44, 77-103`); `MutationObserver` on `domNode` for `data-mark-ring` (`:271-273`); `rf.setCenter(x, y, { zoom, duration: 260 })` (`:172-173`); `addSelectedNodes([id])` (`:193`) |
| `src/window/demo/camera-bridge.tsx:2, 10-94` | Captures `useReactFlow()` into module scope; `fitView`, `setCenter`, `getNode`, `setNodes` |
| `WC/nodes/NodeShell.tsx:9-16, 115-116, 139, 155, 168, 227, 493` | `Handle`, `NodeToolbar`, `NodeResizer`, `useConnection`, `useUpdateNodeInternals` |
| `WC/nodes/GroupNode.tsx:4, 55, 224-274, 354` | `NodeResizer`, `NodeToolbar`, `useReactFlow`, `useStoreApi`; label drag uses `rf.getNode`, `rf.screenToFlowPosition`, `rf.updateNode`, `rf.getNodes` |
| `WC/nodes/PreambleBubble.tsx:3, 25, 28-30` | `useStore(store.transform[2])`; measures `.react-flow__node-toolbar[data-id]` |
| `WC/nodes/TextNode.tsx:12`, `FileNode.tsx:8`, `LinkNode.tsx:4`, `index.ts:2` | `NodeProps`, `NodeTypes` types |
| `WC/edges/WireEdge.tsx:1-2, 86, 116, 138` | `BaseEdge`, `EdgeLabelRenderer`, `getSmoothStepPath` |
| `WC/edges/CanvasLoom.tsx:12, 38-49, 550` | `useStore` selector over `nodeLookup.values()`; reads RF's internal node shape |
| `WC/edges/WirePulseFeed.tsx:11, 39, 52` | `useStoreApi`: `nodeLookup`, `transform`, `width`, `height` |
| `WC/edges/WirePulse.tsx:1`, `FlowTrack.tsx:2` | `ViewportPortal` |
| `WL/flow-nodes.ts:1`, `WL/flow-edges.ts:1` | RF `Node` and `Edge` types |
| `WL/camera-placement.ts:1` | `getViewportForBounds`, `Viewport` |
| `WL/multi-select-gesture.ts:10, 51-76, 82-110` | Flips RF `multiSelectionActive`; calls `addSelectedNodes`, `unselectNodesAndEdges` |
| `WC/useCanvasGroupFocus.ts:4-52` | Structural `GroupFocusFlow` type; `rf.getNode`, `rf.fitView` |
| `WL/terminal-modifier-fence.ts:1-19` | Stops modifier keydown at the terminal because xyflow key hooks listen on window and document |

DOM selector reach-ins (no RF import):

- `WC/TooltipLayer.tsx:35, 141`.
- `WC/nodes/PreambleBubbleView.tsx:115`.
- `WL/canvas-tier.ts:156-157, 186, 188, 306, 316-317`.
- `WL/focus-ownership.ts:36-46` (`FOCUS_SCOPE_SELECTOR`).
- `WL/urgency-step.ts:41` (`CANVAS_ITSELF = ".react-flow__node, .react-flow__edge, .react-flow__pane"`).
- `WL/reach-preview.ts:40, 44-49`.
- `WL/impact-mode.ts:132`.
- `WL/canvas-keyboard-pan.ts:48-52`.
- `WL/modal-stack.ts:419` (sets `aria-hidden` on `.react-flow`).
- `WL/sound/index.ts:42` (stereo pan from a card's `getBoundingClientRect`, `PAN_SPREAD = 0.6`).
- `WC/gallery/KindSeatGallery.tsx:90` and `WC/onboarding/tour-demo.tsx:112` reuse the class `react-flow__node` outside any flow to borrow card styling.

`.react-flow` selectors in CSS, by file: `styles.css` 40; `WS/canvas-lod.css` 37; `WS/canvas-lod-regions.css` 18; `WS/reach-preview.css` 14; `WS/factory-grammar.css` 12; `WC/nodes/spine-card.css` 8; `Rts.css` 6; `WS/seat-card.css` 5; `WC/nodes/kind-seat.css` 2; `WC/work/content-media.css` 2; `WC/edges/wire-pulse.css` 1; `WC/factory-minimap.css` 1; `WC/nodes/preamble-bubble.css` 1.

### Workarounds and past-bug comments

- **Minimap needs RF as a parent.** The whole bottom bar is an RF `Panel` only so the minimap binds to the instance (`Canvas.tsx:1913-1916`).
- **Single-slot viewport hook.** `useOnViewportChange` is one slot shared by the magnifier and the region glance, so the tier gate and the glance gate subscribe to the store instead (`WC/CanvasTierGate.tsx:31-33`; `WC/RegionGlanceGate.tsx:20-23`).
- **Style writes scoped to consumers.** A custom property on the RF root restyled "all 17,843" elements at rest, so scales are written on each consumer by DOM query (`WL/canvas-tier.ts:144-161`). The tier gate comment still describes root writes (`WC/CanvasTierGate.tsx:14-20`); a zoom sweep "wrote them 29 to 83 times" (`:26-27`).
- **No computed-style reads during a rest.** Gathered seat ids are parsed from the cluster style sheet's text: "p95 83 ms against 19 ms" (`WL/canvas-tier.ts:296-306`).
- **Hidden seats cannot composite.** Transform animations on `visibility: hidden` seats ran on the main thread, "171 of them in one zoom sweep" (`WL/canvas-tier.ts:313-322`).
- **Viewport is not composited, on purpose** (`styles.css:1107-1112`), locked by `tests/viewport-promotion.test.ts:19-33`.
- **No `<Background>`**: it re-rendered a full-window SVG pattern per viewport change (`Canvas.tsx:1886-1889`).
- **Modifier keys in a terminal repainted the board**: about 20 ms a press on a 358-node board, through `@xyflow/system XYPanZoom.update` (`WL/terminal-modifier-fence.ts:4-10`).
- **Delete is intercepted**: `onBeforeDelete` always returns false and routes to `deleteNodes` and `deleteEdges` (`Canvas.tsx:677-689`).
- **Selection quirks**: empty `onSelectionChange` reports are ignored (`Canvas.tsx:697-722`); RF re-reports selection (`WL/state.ts:159-163`); a window-capture shift handler toggles selection itself (`Canvas.tsx:1791-1813`); "React Flow drops a selection made before" members mount (`WC/useCanvasGroupFocus.ts:47`).
- **Connect drop target** comes from `document.elementFromPoint` plus `.closest(".react-flow__node")` (`Canvas.tsx:564-566`).
- **Regions are not interactive nodes**: `pointerEvents: "none"`, `selectable: !region`, `draggable: !region` (`WL/flow-nodes.ts:171-248`).
- **`panActivationKeyCode={null}` and `selectionKeyCode={null}`** turn RF's key handling off (`Canvas.tsx:1849-1866`).
- **Mounted-card dependencies**: minimap urgency, region urgency and seat clusters all depend on cards being mounted React components with DOM (section 4, derived state table).
- **Bottom-bar dependency**: minimap and magnifier severity come from `state$.regionSeverityByNodeId`, which is written only while `RtsBottomBar` is mounted (`WC/rts/RtsBottomBar.tsx:566-583`).
- **Two arms already line up**: the lab spike and `zz-zoom-smooth` share one gesture script and one summary, and the e2e probe labels itself `arm: "dom"` (`zz-zoom-smooth:1-13, 184`).
- **Dead settings**: `canvas.showMinimap` and `canvas.fitOnOpen` (`src/shared/settings.ts:99-100`).

### Not read

RF's node toolbar z-index; the core seat-state debounce interval; wizard and dialog host rendering; `WorkbenchChrome`, `WorkbenchPanes`, `PersistentTerminalHost`, `TerminalGridFocus`, `LiveConversationHost` internals; `WL/flow-identity.ts`, `WL/flow-edges.ts`, `WL/region-glance.ts` past line 40, `WL/view-state.ts` past line 40; `perf-hotkeys.spec.ts:140-880`; `docs/canvas-gpu-spike.md` past line 60; the `features-*-gate` tests; `NodePaletteModeDeck.tsx` body; the module that defines `canvasZoomRequest$`.

### Key files

- `src/window/components/Canvas.tsx`
- `src/window/components/FactoryMinimap.tsx`
- `src/window/components/CanvasMagnifier.tsx`
- `src/window/App.tsx`
- `src/window/main.tsx`
- `src/window/styles/layers.css`
- `src/window/components/rts/RtsBottomBar.tsx`
- `src/window/components/rts/RtsBottomBar.css`
- `src/window/lib/model-store.ts`
- `src/window/lib/state.ts`
- `src/window/lib/canvas-tier.ts`
- `src/window/lib/agent-seat-state.ts`
- `src/window/lib/experimental-features.ts`
- `src/shared/feature-catalog.ts`
- `src/shared/features.ts`
- `src/shared/settings.ts`
- `tests/motion-law.test.ts`
- `e2e/harness/launch.ts`
- `e2e/harness/model.ts`
- `e2e/harness/nested-canvas-fixture.ts`
- `e2e/scenarios/zz-zoom-smooth.spec.ts`
- `AGENTS.md`
- `docs/state-architecture.md`
