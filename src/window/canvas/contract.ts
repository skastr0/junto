/**
 * The GPU canvas contract (docs/canvas-gpu-plan.md, "First: the contract").
 *
 * The types every track builds against: the facts the feed sends, the scene
 * ops, the input the shell forwards, the hit a pick returns, the intents the
 * engine emits, the frame facts it reports, the engine's surface and the
 * `CanvasApi` the rest of the app calls. Sections refer to
 * docs/canvas-gpu-architecture.md.
 *
 * Rules this file keeps (section 3, must 9): it imports only from
 * `src/shared/`, and holds types and a few constants, no behaviour. The
 * engine, `paint/`, `feed/` and `shell/` all import it; it imports none of
 * them.
 *
 * Changing it: any track may add to it. A change that alters or removes
 * something another track uses is agreed with that track first, and
 * canvas-lead hears of it. Additions need no agreement.
 */

import type { CanvasName } from "@shared/model/base";
import type { Node as ModelNode } from "@shared/model/kinds";
import type { Wire as ModelWire } from "@shared/model/wire";
import type { RingState } from "@shared/wire/rings";
import type { ThemeMode } from "@shared/theme";
import type { PortraitConfig } from "@shared/agent-portrait";
import type { PortraitExpression } from "@shared/portrait-expression";

// ---------------------------------------------------------------------------
// Geometry. Board units unless a name says screen. One function converts
// screen to board and one converts back (must 8); both live in the engine's
// camera module and nothing else does that arithmetic.
// ---------------------------------------------------------------------------

export type Point = { readonly x: number; readonly y: number };
export type Size = { readonly width: number; readonly height: number };
export type Rect = Point & Size;

/**
 * The camera as today's canvas holds it: the board's offset on screen in CSS
 * pixels, and the zoom (0.15 to 2.5, section 14). It reaches shaders as a
 * matrix built from this (section 23); nothing outside the camera module
 * reads `zoom` to size things, it asks for the scale at a point.
 */
export type Camera = { readonly x: number; readonly y: number; readonly zoom: number };

export const CAMERA_MIN_ZOOM = 0.15;
export const CAMERA_MAX_ZOOM = 2.5;

/** Where a camera move goes. */
export type CameraTarget =
  | { readonly kind: "camera"; readonly camera: Camera }
  /** Fit these board rectangles, with today's padding and zoom cap per caller. */
  | { readonly kind: "fit"; readonly rects: ReadonlyArray<Rect>; readonly padding: number; readonly maxZoom: number }
  /** Centre on a board point, keeping or setting the zoom. */
  | { readonly kind: "centre"; readonly at: Point; readonly zoom?: number }
  /** Zoom by a factor about a screen point (the view's centre when absent). */
  | { readonly kind: "zoomBy"; readonly factor: number; readonly about?: Point }
  | { readonly kind: "zoomTo"; readonly zoom: number; readonly about?: Point };

export type CameraMoveOptions = {
  /** 0 or absent: at once. Moves ease cubic in-out on the smooth zoom path. */
  readonly durationMs?: number;
};

/** Same thresholds and names as `src/window/lib/canvas-tier.ts` (section 11). */
export type CanvasTier = "near" | "mid" | "far" | "overview";

// ---------------------------------------------------------------------------
// Facts in (section 20). The feed sends facts, never drawing instructions:
// `paint/` turns facts into records inside the engine, so a tier change or a
// theme switch repaints without the feed.
// ---------------------------------------------------------------------------

export type NodeId = string;
export type WireId = string;

/** What the canvas knows about a card beyond its model row. */
export type CardDerived = {
  /** The innermost region the card sits in, and how deep that is (0: none). */
  readonly regionId?: NodeId;
  readonly regionDepth: number;
  /** A graph blocker holds this card (`kernel$`). */
  readonly blocked: boolean;
  /** Paint order: model `z`, then id (section 6, the cards band). */
  readonly z: number;
  /**
   * The seat's ring cap (`seat-ring-room.ts`, evened per region): how many
   * times the 52 unit ring may grow at far and overview. Absent: 1.
   */
  readonly ringCap?: number;
  /** The region's name slot, from `region-name-slot.ts` (regions only). */
  readonly nameSlot?: RegionNameSlot;
  /** The region's urgency, direct or held (regions only). */
  readonly regionUrgency?: { readonly kind: "blocked" | "needs-you" | "review"; readonly reach: "direct" | "held" };
  /** A remote peer or stub, and where it lives (spine cards). */
  readonly remote?: { readonly machine?: string };
};

/** `regionNameSlot`'s answer in board units, relative to the region's top left. */
export type RegionNameSlot = {
  readonly rect: Rect;
  readonly fontSize: number;
  /** The name prints over the region's cards (the slot is nested form). */
  readonly nested: boolean;
};

/** The ledger a kind seat's band draws: counts the card already reads. */
export type KindLedgerFact =
  | { readonly kind: "task"; readonly finished: number; readonly open: number; readonly asks: number; readonly stuck: number; readonly backlog: number }
  | { readonly kind: "artifacts"; readonly count: number }
  | { readonly kind: "automations"; readonly on: number; readonly off: number; readonly failed: number }
  | { readonly kind: "page"; readonly tabs: number }
  | { readonly kind: "git"; readonly commits?: number };

/**
 * A kind seat's live state (terminal, task, artifacts, automations, page, git,
 * files, link, file): what its card reads from stores today. The feed derives
 * it; `paint/` reads nothing else about a kind seat.
 */
export type KindLive = {
  /** The name beside the ring. */
  readonly name: string;
  /** The one line beneath it. */
  readonly line: string;
  /** Full text when the line truncates. */
  readonly lineTitle?: string;
  /** `kindStateOf` / `KindState`: resting, working, waiting, review, blocked, done, offline. */
  readonly state: "resting" | "working" | "waiting" | "review" | "blocked" | "done" | "offline";
  readonly ledger?: KindLedgerFact;
  /** The files card's drop target is lit. */
  readonly dropTarget?: boolean;
  /** Task card: show the enqueue instrument. */
  readonly enqueue?: boolean;
  /** Terminal card: the claimed task strip. */
  readonly tasks?: SeatTasksFact;
  /** The line is the "page unbound" or "unbound terminal" fallback. */
  readonly unbound?: boolean;
  /** Epoch ms the state last changed: a `done` ring lands once from here. Absent: long ago. */
  readonly stateSince?: number;
};

/** One row of a spine card (peer, stub). */
export type SpineLive = {
  readonly status: "blocked" | "failed" | "needs-you" | "working" | "off" | "retired" | "none";
  readonly name: string;
  readonly count?: string;
  readonly tag?: string;
  readonly leaf?: string;
  /** Leaf truncates at its head (a path). */
  readonly leafTail?: boolean;
  readonly glyph: string;
  readonly hue: string;
  readonly dashed: boolean;
  readonly meta?: string;
  readonly rows: ReadonlyArray<string>;
  readonly more?: number;
};

/** The task strip a seat or terminal carries (`SeatTaskStrip`). */
export type SeatTasksFact = { readonly state: string; readonly label: string; readonly title: string; readonly more: number };

/** A seat's live state: what its ring, line and marks show right now. */
export type SeatLive = {
  readonly ring: RingState;
  /** The seat's one line under its name: process, reason or last output. */
  readonly line: string;
  /** Today's `cardMark` tone and label (`seat-projections.ts`). */
  readonly mark: { readonly tone: string; readonly label: string };
  /** The seat's urgency, as `seatUrgency$` holds it today; region rollups read it. */
  readonly urgency: number;
  /** The process is running or starting. */
  readonly running: boolean;
  readonly overseer: boolean;
  /** Harness id for the badge, when the seat is a managed agent. */
  readonly harness?: string;
  /** The task the seat holds, for its strip: lead task's state, number and title, and how many more. */
  readonly tasks?: SeatTasksFact;
  /** The preamble bubble, while one is shown. */
  readonly preamble?: {
    /** The speaker's word (AI, Junto, you); absent for the agent's own voice. */
    readonly speaker?: string;
    readonly now: string;
    readonly before?: string;
    /** A hue token name: second, amber, crimson, cyan, green, indigo, violet, steel. */
    readonly hue: string;
    /** The frame is firmer for a signal or failed mail (mix 55 and wash 9, else 30 and 4). */
    readonly strong?: boolean;
    /** The bubble slides sideways by this many board units to stay on screen. */
    readonly dx: number;
    /** A glyph name for the action, drawn at the line's start. */
    readonly glyph?: string;
    /** Epoch ms the current line arrived: it rises 3 board units and fades in over 200 ms. */
    readonly since: number;
  };
  /** `seatSaying`'s parts: how the line is drawn (signal word, failure, AI reading, plain). */
  readonly saying?: {
    readonly kind: "signal" | "failure" | "reading" | "cache" | "plain";
    readonly lead?: string;
    readonly tone?: string;
    readonly stale?: boolean;
    /** A cache line past its window: the words end in a comma and "cache expired" follows in amber. */
    readonly expired?: boolean;
  };
  /** Epoch ms the ring's form last changed: `done` lands once from here. */
  readonly ringSince: number;
  /** Portrait inputs (`portraitDataUri`): seed, mood face, config. */
  readonly portrait?: { readonly seed: string; readonly expression?: PortraitExpression; readonly config?: PortraitConfig };
  /** The seat is a vacant place, not an occupied one. */
  readonly occupancy?: "empty" | "gone";
  /** The agent's node colour (a palette digit or a hex), for the name. */
  readonly nameColor?: string;
};

/** One card: its row as the model stores it, plus what the canvas derives. */
export type CardFact = {
  readonly id: NodeId;
  readonly row: ModelNode;
  readonly derived: CardDerived;
  /** Kind seats only. */
  readonly kind?: KindLive;
  /** Peer and stub cards only. */
  readonly spine?: SpineLive;
};

export type WireFact = {
  readonly id: WireId;
  readonly row: ModelWire;
};

export type ReachEffect = "gains" | "loses" | "both" | "held";
/**
 * A reach preview on one card. `effect` is absent on the card that only
 * carries the words, the one under the pointer when the grabbed card is a
 * region: a mark with no effect paints no ring.
 */
export type ReachMark = { readonly id: NodeId; readonly effect?: ReachEffect; readonly summary?: string };

/** Selection and focus as `state$` holds them (section 15). */
export type SelectionFact = {
  readonly nodeIds: ReadonlyArray<NodeId>;
  readonly wireId?: WireId;
  /** Connection focus: the card whose cone is shown (impact, focus cone). */
  readonly connectionFocusNodeId?: NodeId;
  /**
   * A focus mode dims every card but its members: `impact` (accent) or
   * `connection` (second). `lead` cards sit at 0.72, members at 1, the rest at
   * 0.22 desaturated (`styles.css` focus modes).
   */
  readonly focusMode?: {
    readonly kind: "impact" | "connection";
    readonly rootId: NodeId;
    readonly memberIds: ReadonlyArray<NodeId>;
    readonly leadIds: ReadonlyArray<NodeId>;
    /** The wires in the cone (`impact-edge-in`); absent: wires with both ends among the members. */
    readonly wireIds?: ReadonlyArray<WireId>;
  };
  /** The card holding keyboard focus (the cyan outline). */
  readonly focusedNodeId?: NodeId;
};

/** How wires are shown (section 13, opacity modes). */
export type WireMode = "rest" | "loupe" | "connecting" | "cone" | "far" | "overview";

/**
 * One wire's route as the loom planned it for the settled board (track D,
 * section 13). The feed's loom runs the router and sends points; the engine
 * draws them while the wire's ends still sit where the plan put them, and
 * draws the fallback elbow between the cards' live rectangles otherwise (a
 * card is being dragged, or the model has not yet taken a move).
 */
export type WireRouteFact = {
  readonly id: WireId;
  readonly sourceSide: HandleSide;
  readonly targetSide: HandleSide;
  /** Where the plan met each card: the side's midpoint with the pair lane applied. */
  readonly source: Point;
  readonly target: Point;
  /** The pair lane's shift at each end, already in `source` and `target` (zero when none). */
  readonly lane: { readonly source: Point; readonly target: Point };
  /** The route, source to target; absent: the engine draws the fallback elbow between the anchors. */
  readonly points?: ReadonlyArray<Point>;
  /** One of a cable (three or more wires on one handle): hit within 3 units, not 20. */
  readonly cable: boolean;
};

/** The wire a connect gesture is drawing, board points; the engine draws it in a token's colour. */
export type ConnectionPreview = {
  readonly from: Point;
  readonly fromSide: HandleSide;
  readonly to: Point;
};

/** `WireTrafficKind`: violet mail, amber prompts, green answers. */
export type PulseKind = "notice" | "prompt" | "answer";

/** Everything the feed and the shell may tell the engine. */
export type SceneOp =
  /** A canvas opened: replaces the whole scene. */
  | { readonly kind: "load"; readonly canvas: CanvasName; readonly cards: ReadonlyArray<CardFact>; readonly wires: ReadonlyArray<WireFact> }
  /** One card added or changed: rewrites that card's records only (must 5). */
  | { readonly kind: "card"; readonly fact: CardFact }
  | { readonly kind: "removeCard"; readonly id: NodeId }
  | { readonly kind: "wire"; readonly fact: WireFact }
  | { readonly kind: "removeWire"; readonly id: WireId }
  /** One seat's live state changed: rewrites that seat's bytes and no others. */
  | { readonly kind: "seat"; readonly id: NodeId; readonly live: SeatLive }
  | { readonly kind: "selection"; readonly fact: SelectionFact }
  /** Reach preview marks with their effect and the summary words, or none. */
  | { readonly kind: "reachMarks"; readonly marks: ReadonlyArray<ReachMark> | null }
  | { readonly kind: "theme"; readonly mode: ThemeMode }
  | { readonly kind: "wireMode"; readonly mode: WireMode }
  /**
   * Traffic on a wire from main (`WireTrafficEvent`): one pulse, on the wall
   * clock. `reverse` runs the light target to source (`pickPulseEdge`).
   */
  | { readonly kind: "pulse"; readonly wireId: WireId; readonly at: number; readonly pulse?: PulseKind; readonly reverse?: boolean }
  /** The loom's routes (track D): rewrites those wires' strips and no others. */
  | { readonly kind: "routes"; readonly set: ReadonlyArray<WireRouteFact>; readonly remove: ReadonlyArray<WireId> }
  /** The connection preview while a connect gesture runs, or none. */
  | { readonly kind: "preview"; readonly preview: ConnectionPreview | null }
  /** The reach preview while a drag or connect shows it (section 10). */
  | { readonly kind: "reach"; readonly nodeIds: ReadonlyArray<NodeId> | null }
  /** Hide a card's own text while an overlay editor stands in for it (section 16). */
  | { readonly kind: "editing"; readonly id: NodeId | null };

// ---------------------------------------------------------------------------
// Drawing records (tracks A and C agree this section; B owns what the names
// resolve to). `paint/` turns facts into `Quad`s as plain data; the engine
// interns each `style` into the style table (B), each `sprite` and `text`
// into an atlas cell (B), packs the rest into a fixed-size record at a stable
// slot (A), and draws them in one ordered list. A quad never holds a colour:
// a `ColorRef` names a token, a user's stored colour, or a mix, and B resolves
// it per theme. Section 6, 7, 10.
// ---------------------------------------------------------------------------

/** One bit per tier; a quad is drawn at the tiers whose bits are set. */
export const TIER_BIT = { near: 1, mid: 2, far: 4, overview: 8 } as const;
export type TierMask = number;
export const ALL_TIERS: TierMask = 15;

/**
 * A colour as data. `alpha` is the `color-mix(in oklab, X N%, transparent)`
 * share (0 to 1). `custom` is a colour a node row stores (a hex), painted as
 * stored. `mix` is `color-mix(in oklab, a share%, b)`, share of `a` 0 to 1.
 */
export type ColorRef =
  | { readonly token: string; readonly alpha?: number }
  | { readonly custom: string; readonly alpha?: number }
  | { readonly mix: readonly [ColorRef, ColorRef]; readonly share: number };

export type FillSpec =
  | { readonly kind: "flat"; readonly color: ColorRef }
  /** Two-stop linear gradient; CSS angle in degrees (135 runs top left to bottom right). */
  | { readonly kind: "gradient"; readonly angle: number; readonly from: ColorRef; readonly to: ColorRef };

export type StrokeSpec = {
  readonly color: ColorRef;
  readonly width: number;
  /** Dash and gap in board units; absent is solid. */
  readonly dash?: readonly [number, number];
  /** The stroke sits outside the rectangle, as an outline with offset does. */
  readonly outside?: boolean;
};

/**
 * A shadow by the name `SHADOW` (src/shared/theme/chrome.ts) gives it, with
 * the colour for the layers that have none of their own (a reach hue, an
 * urgency, a cluster rim).
 */
export type ShadowSpec = { readonly name: string; readonly tint?: ColorRef };

/** What a CSS class is today. The engine's style table interns these structurally. */
export type QuadStyle = {
  readonly fill?: FillSpec;
  readonly stroke?: StrokeSpec;
  readonly shadow?: ShadowSpec;
  /** Colour of a text run or a coverage glyph. */
  readonly ink?: ColorRef;
  /** Multiplies the quad's alpha (the stub's 0.72, an empty note's 0.88). */
  readonly opacity?: number;
};

export type Radii = number | readonly [tl: number, tr: number, br: number, bl: number];

/**
 * Where a quad is measured. `board`: in board units. The others hold a size on
 * screen around `anchor` (a point in the card's own board units), by the
 * engine's zoom scales (section 11): `seat` is the far ring's scale,
 * `max(1, min(farSeat, cap))` (overview: `max(seatFloor, min(farSeat, cap))`),
 * `node` is `--node-s`.
 */
export type ScaleRule =
  | { readonly kind: "board" }
  /** 1 at near and mid. Strokes and shadows scale with the quad. */
  | { readonly kind: "seat"; readonly cap: number; readonly anchor: Point }
  /**
   * The far name tag: its offset from `anchor` scales by the seat scale, and
   * the tag itself by `farSeat * 1.4` about its top centre (canvas-lod.css).
   */
  | { readonly kind: "seatTag"; readonly cap: number; readonly anchor: Point }
  | { readonly kind: "node"; readonly anchor: Point };

/**
 * The five ring motions and the band motions (section 10). Periods come from
 * `RING_MOTION` and `BAND_PERIOD_MS`; the engine holds no tempo of its own.
 * Phase is wall time modulo `MARK_PHASE_MS`.
 *   turn      rotate 0 to 360, linear; `fade` also breathes once a lap (glint)
 *   send      scale 1 to 1.31, opacity 1 to 0 by 81.25% of the period
 *   beat      opacity 0, 1, 0, .55, 0 at 0, 18.75, 37.5, 50, 68.75%
 *   breathe   opacity 0, 1, 0, ease in-out
 *   land      once from `since`, 720 ms: scale .82 to 1, opacity 0 to 1, then gone
 *   landed    opacity 0 until `since` + 720 ms, 1 after (the base under a land)
 *   bandFade  opacity .25, 1, .25
 *   blink     opacity 1 until 49%, .1 from 50%
 *   ripple    opacity .8 to 0 with scale 1 to 1.22
 *   glint     opacity 0, .9 at 30%, 0 at 60%
 *   shake     translateX 0, -1, 1 (board units at 52 per ring)
 *   reach     opacity 1 to .55 and scale 1 to 1.015, ease in-out
 *   rise      once from `since`: translateY 3 to 0 and opacity 0 to 1 in 200 ms
 */
export type QuadMotion =
  | { readonly kind: "turn"; readonly periodMs: number; readonly ccw?: boolean; readonly fade?: boolean }
  | { readonly kind: "send" | "beat" | "breathe" | "bandFade" | "blink" | "ripple" | "glint" | "shake" | "reach"; readonly periodMs: number }
  | { readonly kind: "land" | "landed"; readonly since: number }
  /** Once from `since`: rises 3 board units into place while opacity goes 0 to 1, 200 ms, ease `enter` (the preamble line). */
  | { readonly kind: "rise"; readonly since: number };

/** A cell of the ring atlas (`activity-atlas.ts`, painted once per theme). */
export type RingCell = { readonly col: number; readonly row: number };

export type SpriteRef =
  /** A cell of the mark atlas. */
  | { readonly atlas: "mark"; readonly cell: RingCell }
  /** Generated art (a portrait, a kind icon, a band layer, a harness mark) the shell rasterizes at `px`. */
  | { readonly atlas: "image"; readonly key: string; readonly svg: string; readonly size: Size }
  /** A coverage glyph tinted by `style.ink` (the far-tier glyphs). */
  | { readonly atlas: "glyph"; readonly name: string }
  /** A bitmap from the content store (note and file images). */
  | { readonly atlas: "media"; readonly ref: string; readonly fit: "contain" | "cover" };

export type FontRole = "mono" | "display" | "body";

/** One run of text in one style; B shapes and caches it (section 8). */
export type TextRun = {
  readonly text: string;
  readonly font: FontRole;
  readonly size: number;
  readonly weight: number;
  /** Letter spacing in em. */
  readonly tracking?: number;
  /** Line height as a multiple of size. */
  readonly leading?: number;
  readonly upper?: boolean;
  readonly italic?: boolean;
  readonly tabular?: boolean;
  readonly align?: "start" | "center";
  /** `end`: ellipsis; `head`: ellipsis at the head (a path); `clamp2`: two lines; `none`. */
  readonly truncate: "end" | "head" | "clamp2" | "none";
  /** Wrap width in board units. */
  readonly width: number;
  /** A ground-coloured halo behind the glyphs. */
  readonly halo?: boolean;
};

export type QuadKind = "shape" | "shadow" | "sprite" | "text";

/** Which paint band the quad draws in (section 6). Quads of one card keep `z` order inside it. */
export type PaintBand = "regions" | "cards" | "lifted";

export type Quad = {
  /** Stable within its card across repaints, so a style change is a transition on one slot. */
  readonly key: string;
  readonly kind: QuadKind;
  readonly band: PaintBand;
  /** Order inside the card, low first. */
  readonly z: number;
  /** In board units, relative to the card's top left. */
  readonly rect: Rect;
  readonly tiers: TierMask;
  readonly scale: ScaleRule;
  readonly style: QuadStyle;
  /** `shape`: its outline; absent is a rectangle. */
  /** `triangle` has its apex up; `flip` mirrors any shape top to bottom. */
  readonly shape?: "rect" | "disc" | "triangle";
  readonly flip?: boolean;
  readonly radii?: Radii;
  readonly sprite?: SpriteRef;
  readonly text?: TextRun;
  /**
   * A shadow's element inset in board units: the quad is grown past the
   * element by this much, and no shadow layer paints inside the element.
   */
  readonly hole?: number;
  readonly motion?: QuadMotion;
  /**
   * `live`: drawn only while motion runs; `paused`: only while it does not
   * (hidden window, reduced motion), which shows a ring's rest pose.
   */
  readonly gate?: "live" | "paused";
  /** The part of the card this quad answers pointer input for (picking, section 15). */
  readonly part?: Part;
};

/**
 * What the engine feeds a paint function about the card beyond its facts.
 * Hover is the engine's own; the rest come from `SelectionFact`.
 */
export type CardView = {
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly keyboardFocus: boolean;
  /** The card is being dragged or its overlay editor stands in for it. */
  readonly editing: boolean;
  readonly dragging: boolean;
  /** A wire is being drawn: the card shows its source handles. */
  readonly connecting?: boolean;
  /** The handle the gesture would land on (the DOM's `connectingto`), only on the card that owns it. */
  readonly connectTarget?: { readonly nodeId: NodeId; readonly side: HandleSide; readonly role: "source" | "target" };
  readonly reach?: ReachMark;
  readonly focus?: { readonly kind: "impact" | "connection"; readonly role: "root" | "member" | "lead" | "outsider" };
  /** The part under the pointer, where it matters to paint (a region's title bar or frame strips). */
  readonly hoveredPart?: Part["kind"];
  /** The theme the generated art (portraits, icons, bands) is made for. */
  readonly mode: ThemeMode;
  /** Region name fades from `region-glance.ts` (0 to 1): regions and sub-regions. Regions only. */
  readonly glance?: { readonly region: number; readonly sub: number };
};

/** The environment paint is handed: text measurement, from the engine's text atlas (section 8). */
export type PaintEnv = {
  /** Width in board units of the run on one line, untruncated. */
  readonly measure: (run: TextRun) => number;
};

/** What `paintCard` returns: the quads, and the card-wide values the engine animates. */
export type CardPaint = {
  readonly quads: ReadonlyArray<Quad>;
  /** The card's group opacity and saturation (focus dimming, 0.18 s ease). */
  readonly dim: { readonly opacity: number; readonly saturate: number };
  /** Lift in board units (hover, 1px, 0.16 s ease). */
  readonly lift: number;
};

// ---------------------------------------------------------------------------
// Input in. The shell forwards browser input as plain data. Screen points are
// CSS pixels relative to the canvas element's top left.
// ---------------------------------------------------------------------------

export type Modifiers = {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
};

export type CanvasInput =
  | {
      readonly kind: "pointer";
      readonly phase: "down" | "move" | "up" | "cancel" | "leave";
      readonly pointerId: number;
      readonly at: Point;
      /** The button that changed (0 left, 1 middle, 2 right), and those held. */
      readonly button: number;
      readonly buttons: number;
      readonly modifiers: Modifiers;
      /** The browser's click count on down and up (2 for a double click). */
      readonly clicks: number;
    }
  | {
      readonly kind: "wheel";
      readonly at: Point;
      readonly dx: number;
      readonly dy: number;
      /** 0 pixels, 1 lines, 2 pages, as `WheelEvent.deltaMode`. */
      readonly deltaMode: number;
      readonly modifiers: Modifiers;
    }
  /** Held keys for keyboard pan (section 14); every other key stays in the key dispatcher. */
  | { readonly kind: "key"; readonly code: string; readonly down: boolean; readonly modifiers: Modifiers }
  | { readonly kind: "resize"; readonly width: number; readonly height: number; readonly pixelRatio: number }
  /** Hidden page, or an opaque surface over the whole canvas: no one can see it. */
  | { readonly kind: "visibility"; readonly visible: boolean };

// ---------------------------------------------------------------------------
// Picking (section 15). One function over the spatial index, in paint order.
// ---------------------------------------------------------------------------

/**
 * What picking asks of the engine's spatial index (section 6, "Culling"): a
 * grid over the board, queried in board units and answered in paint order,
 * bottom first. Track A owns the index; track F owns the pick over it.
 */
export interface SpatialIndex {
  /** Cards whose drawn rectangle contains the point. */
  readonly cardsAt: (at: Point) => ReadonlyArray<NodeId>;
  /** Cards whose drawn rectangle is within `slop` board units of the point. */
  readonly cardsNear: (at: Point, slop: number) => ReadonlyArray<NodeId>;
  /** Wires whose route is within `slop` board units of the point. */
  readonly wiresAt: (at: Point, slop: number) => ReadonlyArray<WireId>;
}

export type HandleSide = "top" | "right" | "bottom" | "left";

export type Part =
  | { readonly kind: "pane" }
  | { readonly kind: "body" }
  | { readonly kind: "resize"; readonly corner: "nw" | "ne" | "se" | "sw" }
  /** One of the four edge lines of the resizer (rf-system:3115-3116): resizes one axis. */
  | { readonly kind: "resizeEdge"; readonly edge: "n" | "e" | "s" | "w" }
  | { readonly kind: "handle"; readonly side: HandleSide; readonly role: "source" | "target"; readonly id: string }
  | { readonly kind: "verbZone"; readonly verb: string }
  | { readonly kind: "ringFlag" }
  | { readonly kind: "taskEnqueue" }
  | { readonly kind: "bubbleClose" }
  | { readonly kind: "noteLink"; readonly href: string }
  | { readonly kind: "image" }
  | { readonly kind: "regionTitle" }
  | { readonly kind: "regionFrame" }
  | { readonly kind: "wire" }
  | { readonly kind: "cluster"; readonly memberIds: ReadonlyArray<NodeId> };

export type Hit = {
  /** The card the part belongs to; absent for the pane, a wire and a cluster. */
  readonly nodeId?: NodeId;
  readonly wireId?: WireId;
  readonly part: Part;
  /** The board point under the pointer. */
  readonly at: Point;
};

// ---------------------------------------------------------------------------
// Intents out (section 4). The engine says what happened; the shell turns it
// into today's writers (`model-edits.ts`, `commitCommands`, `state$`).
// ---------------------------------------------------------------------------

export type Intent =
  | { readonly kind: "select"; readonly nodeIds: ReadonlyArray<NodeId>; readonly mode: "replace" | "toggle" | "add" }
  | { readonly kind: "selectWire"; readonly wireId: WireId }
  | { readonly kind: "clearSelection" }
  /** A drag or region drag dropped: final board positions of every card that moved. */
  | { readonly kind: "move"; readonly positions: ReadonlyArray<{ readonly id: NodeId } & Point> }
  /** A resize released: the card's final board rectangle. */
  | { readonly kind: "resize"; readonly id: NodeId; readonly rect: Rect }
  /** `targetHandle` carries the landed side (`t-left`) or zone (`verb:feeds`), as `addEdge` reads it for `toSide`. */
  | { readonly kind: "connect"; readonly source: NodeId; readonly target: NodeId; readonly sourceHandle?: string; readonly targetHandle?: string; readonly verb?: string }
  /** A double click, or a part that opens something (image, ring flag, note link). */
  | { readonly kind: "open"; readonly nodeId: NodeId; readonly part: Part }
  | { readonly kind: "menu"; readonly target: "pane" | "card" | "selection" | "wire"; readonly nodeId?: NodeId; readonly wireId?: WireId; readonly at: Point; readonly screen: Point }
  | { readonly kind: "hover"; readonly hit: Hit | null }
  | { readonly kind: "delete"; readonly nodeIds: ReadonlyArray<NodeId>; readonly wireIds: ReadonlyArray<WireId> }
  | { readonly kind: "enqueueTask"; readonly nodeId: NodeId }
  | { readonly kind: "closeBubble"; readonly nodeId: NodeId }
  /** A drag or connect in progress, for the reach preview and edge auto-pan feedback. */
  | { readonly kind: "gesture"; readonly gesture: "drag" | "connect" | "marquee" | "resize" | null; readonly nodeIds: ReadonlyArray<NodeId> }
  /** A double click on the empty pane: a new note at this board point (Canvas.tsx:733-742 means it). */
  | { readonly kind: "addNote"; readonly at: Point }
  /**
   * Right click on an unselected card while others are selected: the connect
   * menu, from these sources to that card (Canvas.tsx:1665-1688).
   */
  | { readonly kind: "connectMenu"; readonly targetId: NodeId; readonly sourceIds: ReadonlyArray<NodeId>; readonly at: Point; readonly screen: Point }
  /** The same with Shift: connect them all at once and keep the selection (Canvas.tsx:1673-1677). */
  | { readonly kind: "connectAll"; readonly targetId: NodeId; readonly sourceIds: ReadonlyArray<NodeId> }
  /** A marquee that took two or more cards ended: the multi-select menu opens beside their board bounds (Canvas.tsx:1698-1716). */
  | { readonly kind: "marqueeMenu"; readonly nodeIds: ReadonlyArray<NodeId>; readonly bounds: Rect };

// ---------------------------------------------------------------------------
// Frame facts out (section 5, step 7). Reported once per drawn frame that
// changed them. The shell writes anchored rectangles straight to overlay
// elements' styles, with no render (section 16).
// ---------------------------------------------------------------------------

export type ZoomScales = {
  /** Today's `--far-seat-scale`, `--seat-floor-scale` and `--node-s`. */
  readonly farSeat: number;
  readonly seatFloor: number;
  readonly node: number;
};

export type FrameFacts = {
  readonly at: number;
  readonly camera: Camera;
  readonly tier: CanvasTier;
  readonly scales: ZoomScales;
  /** The camera has not moved for 160 ms (section 14). */
  readonly settled: boolean;
  /** Screen rectangles of the cards the shell anchors overlays to. */
  readonly anchors: ReadonlyArray<{ readonly id: NodeId; readonly rect: Rect }>;
  /** The marquee box during a pane drag, in screen pixels; null when not dragging. */
  readonly marquee: Rect | null;
};

/** The engine's own counters, for the frame test and the performance harness. */
export type EngineStats = {
  readonly frames: number;
  /** Device generation the surface is configured for; 0 before any. */
  readonly generation: number;
  /** Bytes uploaded since the engine started, and in the last frame. */
  readonly uploadedBytes: number;
  readonly lastUploadRanges: ReadonlyArray<{ readonly buffer: string; readonly offset: number; readonly size: number }>;
  /** Script time of the last frame, in ms, by the injected clock. */
  readonly lastFrameMs: number;
  /** Text and image rasters waiting for budget. */
  readonly rasterQueue: number;
};

// ---------------------------------------------------------------------------
// The engine (section 4). Everything it needs from the browser is handed in.
// ---------------------------------------------------------------------------

export interface FrameScheduler {
  readonly request: (frame: (now: number) => void) => number;
  readonly cancel: (handle: number) => void;
}

/** Images (portraits, icons, bands, media) become bitmaps through this. */
export type Rasterize = (source: { readonly svg: string } | { readonly url: string }, size: Size) => Promise<ImageBitmap>;

export interface Engine {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  /**
   * Ask for a frame without a scene change: the atlas calls this when a
   * raster lands, so the cells table and the new cell draw next frame.
   */
  readonly invalidate: () => void;
  readonly input: (event: CanvasInput) => void;
  readonly camera: () => Camera;
  readonly moveCamera: (to: CameraTarget, options?: CameraMoveOptions) => void;
  readonly screenToBoard: (screen: Point) => Point;
  readonly boardToScreen: (board: Point) => Point;
  readonly pick: (screen: Point) => Hit | null;
  readonly rectOf: (id: NodeId) => Rect | undefined;
  /** Ask for a card's screen rectangle in every frame's facts. */
  readonly anchor: (id: NodeId) => () => void;
  readonly onIntent: (listener: (intent: Intent) => void) => () => void;
  readonly onFrame: (listener: (facts: FrameFacts) => void) => () => void;
  /** The seat's turning ring angle in degrees at the wall clock, for the phase test. */
  readonly ringAngle?: (id: NodeId) => number | undefined;
  readonly stats: () => EngineStats;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// The CanvasApi (section 19): one object for the rest of the app, provided by
// the shell through context and as a module handle. It replaces `useReactFlow`,
// `useStoreApi` and every DOM lookup of `.react-flow`. Calls that return values
// are synchronous: the shell mirrors the camera and rectangles.
// ---------------------------------------------------------------------------

export interface CanvasApi {
  readonly screenToBoard: (screen: Point) => Point;
  readonly boardToScreen: (board: Point) => Point;
  readonly camera: () => Camera;
  /** Hears the camera once per changed frame. */
  readonly onCamera: (listener: (camera: Camera) => void) => () => void;
  readonly moveCamera: (to: CameraTarget, options?: CameraMoveOptions) => void;
  /** Fit view: padding 0.18, max zoom 1.15 with regions else 1.35, 320 ms. */
  readonly fit: (options?: { readonly durationMs?: number }) => void;
  /** Focus cards: padding 0.35, max zoom 1.45, 360 ms unless the caller says otherwise. */
  readonly focusNodes: (
    ids: ReadonlyArray<NodeId>,
    options?: { readonly durationMs?: number; readonly padding?: number; readonly maxZoom?: number },
  ) => void;
  readonly zoomBy: (factor: number, options?: CameraMoveOptions) => void;
  readonly zoomTo: (zoom: number, options?: CameraMoveOptions) => void;
  /** A card's board rectangle, and the bounds of several. */
  readonly rectOf: (id: NodeId) => Rect | undefined;
  readonly boundsOf: (ids: ReadonlyArray<NodeId>) => Rect | undefined;
  /** A card's rectangle on screen, in CSS pixels relative to the page. */
  readonly screenRectOf: (id: NodeId) => Rect | undefined;
  readonly pick: (screen: Point) => Hit | null;
  /** Keep `element` over a card, written each frame with no render. */
  readonly anchor: (id: NodeId, element: HTMLElement) => () => void;
  readonly setWireMode: (mode: WireMode) => void;
  readonly tier: () => CanvasTier;
  /** The canvas element, for focus and the focus law's scope. */
  readonly element: () => HTMLElement | null;
  /**
   * A transient position over the model, for the demo's tween (nothing is
   * written to the model until the tween ends). `null` drops every override.
   */
  readonly previewMoves?: (moves: ReadonlyArray<{ readonly id: NodeId } & Point> | null) => void;
  /**
   * The DOM elements a card is drawn as, when this canvas draws cards as DOM
   * (the old canvas). Empty under the GPU canvas: the marks a legacy caller
   * sets live in its nodes, and the new canvas paints its own.
   */
  readonly cardElements?: (id: NodeId) => ReadonlyArray<Element>;
}

/**
 * The test hook (section 22), exposed by the shell in test and development
 * builds only, on `window.__juntoCanvas`. The e2e helper reads it under the
 * new canvas; clicks and drags stay real pointer input at the points it gives.
 */
export interface CanvasTestHook {
  readonly ready: () => boolean;
  readonly cardIds: () => ReadonlyArray<NodeId>;
  readonly regionIds: () => ReadonlyArray<NodeId>;
  /** Screen rectangle of a card, or of one of its parts, in page CSS pixels. */
  readonly rectOf: (id: NodeId, part?: Part["kind"]) => Rect | undefined;
  readonly textOf: (id: NodeId) => string | undefined;
  readonly selection: () => ReadonlyArray<NodeId>;
  /** The card holding the cyan keyboard focus ring, or "" when none does. */
  readonly focused?: () => NodeId | "";
  readonly camera: () => Camera;
  /**
   * Move the camera at once, without an ease, so a spec can put two canvases
   * at one exact camera instead of wheeling each toward it.
   */
  readonly moveCamera?: (camera: Camera) => void;
  readonly settled: () => boolean;
  readonly tier: () => CanvasTier;
  readonly stats: () => EngineStats;
  /**
   * The seat's ring angle in degrees, 0 to 360, as last drawn — the value the
   * DOM ring's `rotate()` shows at the same instant (section 10's phase
   * test). Absent until the engine exposes it; undefined when the seat has
   * no turning ring.
   */
  readonly ringAngle?: (id: NodeId) => number | undefined;
  /**
   * The ring room cap the feed derived for a ringed card, the number the DOM
   * puts in `--ring-cap`; undefined for a card with no ring.
   */
  readonly ringCapOf?: (id: NodeId) => number | undefined;
  /**
   * The multiplier the seat scale rule draws that card's ring at in the
   * tier on screen: 1 at near and mid, the capped far scale at far, the
   * floor at overview. Undefined for a card with no ring.
   */
  readonly seatScaleOf?: (id: NodeId) => number | undefined;
  /**
   * The reach marks the shell handed the canvas on its last step, or null
   * when none are painted. The drag preview's facts, for a test: the shell
   * computes them, the canvas paints them.
   */
  readonly reachMarks?: () => ReadonlyArray<ReachMark> | null;
  /**
   * How many atlas cell rasterizations have started (one per new cell key).
   * A camera gesture must start none: the raster in hand is scaled until the
   * camera rests (section 8 rule 2).
   */
  readonly atlasRequests?: () => number;
  /**
   * Cell rasterizations still in flight: queued jobs plus landed cells not
   * yet uploaded. A spec waits for zero before it reads pixels.
   */
  readonly atlasPending?: () => number;
}
