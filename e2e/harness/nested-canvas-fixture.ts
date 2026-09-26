/**
 * Deterministic nested-region stress canvas.
 *
 * The canvas that breaks rendering is not a big flat board, it is a board of
 * regions inside regions: every level stacks another translucent fill, border
 * and zoom-driven label over the same pixels. This generator builds that board
 * on purpose, from a seed, so every level-of-detail, culling and raster
 * measurement runs against the same geometry and a regression check can say
 * "this board, this camera, these numbers".
 *
 * The output is a plain CanvasDoc (plus optional open agent signals, so seat
 * rings have something to wait on). Seed it with
 * `launchJunto({ stressCanvas: { preset: "nested" } })`, or call
 * `buildNestedCanvasFixture` and pass the doc to `seedCanvases` yourself.
 *
 * Layout is bottom-up: a region's size is its own members' grid plus its child
 * regions' grid, padded, with a per-region slack factor so fills are uneven and
 * leave empty ground the way operators' regions do. Every member and child
 * region lies fully inside its parent's rect, which is the membership predicate
 * (shared/graph.ts regionStack). Same seed and spec, same document, byte for
 * byte.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { CanvasDoc, CanvasEdge, CanvasNode, GroupNode, TextNode } from "../../src/shared/canvas";
import { verbsForPair, type Verb } from "../../src/shared/physics/verbs";
import { agentTextNode, canvasDoc, terminalTextNode, textNode, verbEdge } from "./sandbox";

/** A count, or an inclusive [min, max] range drawn from the seeded generator. */
export type NestedCount = number | readonly [number, number];

export interface NestedCanvasSpec {
  /** PRNG seed; the whole board follows from it. */
  readonly seed: number;
  /** Regions at the top level. */
  readonly topRegions: number;
  /**
   * Child regions per region, one entry per nesting level below the top.
   * `[3, 2]` is three children under each top region and two under each of
   * those: three levels of regions in all.
   */
  readonly branching: ReadonlyArray<NestedCount>;
  /** Agent seats in a region with no child regions. */
  readonly seatsPerLeaf: NestedCount;
  /** Agent seats in a region that also holds child regions. */
  readonly seatsPerInterior: NestedCount;
  /** Free notes per region. */
  readonly notesPerRegion: NestedCount;
  /** Every Nth region (in build order) also holds a terminal; 0 for none. */
  readonly terminalEvery: number;
  /** Every Nth region (in build order) also holds a git card; 0 for none. */
  readonly gitEvery: number;
  /** Free notes outside every region. */
  readonly looseNotes: number;
  /** Extra agent-to-agent wires between random seats anywhere on the board. */
  readonly crossWires: number;
  /** Fraction of seats (0..1) that carry one open signal. */
  readonly signalFraction: number;
  /** Largest extra padding factor on a region's content (1 = snug). */
  readonly maxSlack: number;
}

export type NestedCanvasPresetName = "nested" | "deep" | "max" | "factory-like";

/**
 * - `nested`: four levels, 44 regions, about 200 seats. The default.
 * - `deep`: six levels, 63 regions, about 200 seats. Nesting depth first.
 * - `max`: five levels, 138 regions, about 250 seats. Region count first.
 * - `factory-like`: sized like the operator's FACTORY board from its counts
 *   (about 45 regions over three levels, 40 seats, 21 notes, four terminals,
 *   21 wires, many sparse top-level regions). Synthetic. For the real shape
 *   use `loadFactoryShapeCanvas`.
 */
export const NESTED_CANVAS_PRESETS: Readonly<Record<NestedCanvasPresetName, NestedCanvasSpec>> = {
  nested: {
    seed: 1,
    topRegions: 2,
    branching: [3, 2, 2],
    seatsPerLeaf: [6, 10],
    seatsPerInterior: [1, 2],
    notesPerRegion: [0, 1],
    terminalEvery: 5,
    gitEvery: 7,
    looseNotes: 3,
    crossWires: 24,
    signalFraction: 0.1,
    maxSlack: 1.5,
  },
  deep: {
    seed: 2,
    topRegions: 1,
    branching: [2, 2, 2, 2, 2],
    seatsPerLeaf: [5, 7],
    seatsPerInterior: [0, 1],
    notesPerRegion: [0, 1],
    terminalEvery: 6,
    gitEvery: 9,
    looseNotes: 2,
    crossWires: 20,
    signalFraction: 0.1,
    maxSlack: 1.35,
  },
  max: {
    seed: 3,
    topRegions: 3,
    branching: [3, 2, 2, 2],
    seatsPerLeaf: [2, 4],
    seatsPerInterior: [0, 1],
    notesPerRegion: 0,
    terminalEvery: 8,
    gitEvery: 12,
    looseNotes: 6,
    crossWires: 40,
    signalFraction: 0.12,
    maxSlack: 1.5,
  },
  "factory-like": {
    seed: 4,
    topRegions: 20,
    branching: [[0, 2], [0, 1]],
    seatsPerLeaf: [0, 2],
    seatsPerInterior: [0, 1],
    notesPerRegion: [0, 1],
    terminalEvery: 11,
    gitEvery: 0,
    looseNotes: 0,
    crossWires: 8,
    signalFraction: 0.1,
    maxSlack: 2.2,
  },
};

/** Counts the board was built with, for reports and assertions. */
export interface NestedCanvasStats {
  readonly regions: number;
  /** Levels of regions; a board of top-level regions only has depth 1. */
  readonly depth: number;
  readonly seats: number;
  readonly notes: number;
  readonly terminals: number;
  readonly gits: number;
  readonly edges: number;
  readonly signals: number;
  /** Bounding box of every node, flow px. */
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface NestedCanvasFixture {
  readonly doc: CanvasDoc;
  readonly stats: NestedCanvasStats;
  /** Open signals on a seeded share of seats, addressed to `canvasName`. */
  readonly signals: (canvasName: string) => ReadonlyArray<AgentSignal>;
}

/**
 * The operator's display: a 1726x1083 pt window on a Retina (2x) screen. The
 * harness window is 1320x900 at 1x unless a spec asks, and every earlier
 * flicker measurement ran at 1x. Spread into launch options.
 */
export const OPERATOR_DISPLAY = {
  windowContentSize: { width: 1726, height: 1083 },
  electronArgs: ["--force-device-scale-factor=2"],
} as const;

// --- deterministic randomness -------------------------------------------------

/** mulberry32: small, fast, and the same sequence on every platform. */
const makeRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const drawCount = (random: () => number, count: NestedCount): number =>
  typeof count === "number"
    ? count
    : count[0] + Math.floor(random() * (count[1] - count[0] + 1));

// --- geometry -------------------------------------------------------------------

/** Stored footprints (what membership reads), matching the sandbox builders. */
const SEAT = { width: 240, height: 96 } as const;
const TERMINAL = { width: 260, height: 110 } as const;
const GIT = { width: 176, height: 44 } as const;
const NOTE = { width: 220, height: 84 } as const;

const CELL_W = 290;
const CELL_H = 140;
const MEMBER_COLS = 4;
const PAD = 40;
/** Room above the members for the region's title band. */
const HEADER = 72;
const CHILD_GAP = 60;
const TOP_GAP = 420;

const REGION_COLORS = ["1", "2", "3", "4", "5", "6"] as const;

const REGION_WORDS = [
  "Payments", "Search", "Ingest", "Billing", "Mobile", "Platform", "Growth", "Infra",
  "Research", "Docs", "Release", "Security", "Data", "Support", "Design", "Ops",
  "Command center", "Harnesses", "Family and health", "Ether workspace",
] as const;

const NOTE_TEXT = [
  "Plan\n- land the parser\n- cut the release branch\n- write the migration note",
  "Open questions for the review on Thursday",
  "Runbook: restart the worker, then check the queue depth before paging anyone.",
  "Ideas",
] as const;

type MemberKind = "seat" | "note" | "terminal" | "git";

interface RegionPlan {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly color: string | undefined;
  readonly members: ReadonlyArray<MemberKind>;
  readonly children: ReadonlyArray<RegionPlan>;
  readonly slack: number;
}

interface Measured {
  readonly plan: RegionPlan;
  readonly width: number;
  readonly height: number;
  readonly membersWidth: number;
  readonly membersHeight: number;
  readonly children: ReadonlyArray<Measured>;
  /** Child grid rows: indices into `children`. */
  readonly rows: ReadonlyArray<ReadonlyArray<number>>;
}

const planRegions = (spec: NestedCanvasSpec, random: () => number): ReadonlyArray<RegionPlan> => {
  let built = 0;
  const plan = (path: ReadonlyArray<number>, level: number): RegionPlan => {
    const childCount = level < spec.branching.length ? drawCount(random, spec.branching[level]!) : 0;
    const children = Array.from({ length: childCount }, (_, index) => plan([...path, index + 1], level + 1));
    built += 1;
    const members: MemberKind[] = [];
    const seats = drawCount(random, children.length > 0 ? spec.seatsPerInterior : spec.seatsPerLeaf);
    for (let i = 0; i < seats; i += 1) members.push("seat");
    const notes = drawCount(random, spec.notesPerRegion);
    for (let i = 0; i < notes; i += 1) members.push("note");
    if (spec.terminalEvery > 0 && built % spec.terminalEvery === 0) members.push("terminal");
    if (spec.gitEvery > 0 && built % spec.gitEvery === 0) members.push("git");
    const word = REGION_WORDS[Math.floor(random() * REGION_WORDS.length)]!;
    const colorPick = Math.floor(random() * (REGION_COLORS.length + 1));
    return {
      id: `region-${path.join("-")}`,
      label: level === 0 ? word : `${word} ${path.join(".")}`,
      level,
      color: REGION_COLORS[colorPick],
      members,
      children,
      slack: 1 + random() * (spec.maxSlack - 1),
    };
  };
  return Array.from({ length: spec.topRegions }, (_, index) => plan([index + 1], 0));
};

const measure = (plan: RegionPlan): Measured => {
  const children = plan.children.map(measure);
  const cols = Math.min(plan.members.length, MEMBER_COLS);
  const membersWidth = cols * CELL_W;
  const membersHeight = Math.ceil(plan.members.length / MEMBER_COLS) * CELL_H;
  const rowWidth = (row: ReadonlyArray<number>): number =>
    row.reduce((sum, index) => sum + children[index]!.width, 0) + (row.length - 1) * CHILD_GAP;
  const rowHeight = (row: ReadonlyArray<number>): number =>
    Math.max(...row.map((index) => children[index]!.height));
  const arrange = (perRow: number) => {
    const rows: number[][] = [];
    children.forEach((_, index) => {
      if (index % perRow === 0) rows.push([]);
      rows[rows.length - 1]!.push(index);
    });
    const width = rows.length > 0 ? Math.max(...rows.map(rowWidth)) : 0;
    const height =
      rows.reduce((sum, row) => sum + rowHeight(row), 0) + Math.max(0, rows.length - 1) * CHILD_GAP;
    return { rows, width, height };
  };
  // The child grid whose shape is closest to a landscape 16:10, so depth does
  // not stretch the board into a strip.
  const grid = Array.from({ length: Math.max(1, children.length) }, (_, index) => arrange(index + 1)).reduce(
    (best, next) =>
      Math.abs(Math.log((next.width || 1) / (next.height || 1) / 1.6)) <
      Math.abs(Math.log((best.width || 1) / (best.height || 1) / 1.6))
        ? next
        : best,
  );
  const rows = grid.rows;
  const contentWidth = Math.max(membersWidth, grid.width, CELL_W);
  const contentHeight =
    Math.max(membersHeight + grid.height + (membersHeight > 0 && grid.height > 0 ? CHILD_GAP : 0), CELL_H);
  // Slack is empty ground added once per region, not compounded per level.
  return {
    plan,
    width: Math.round(PAD * 2 + contentWidth + (plan.slack - 1) * CELL_W * 2),
    height: Math.round(HEADER + PAD + contentHeight + (plan.slack - 1) * CELL_H * 2),
    membersWidth,
    membersHeight,
    children,
    rows,
  };
};

// --- build ------------------------------------------------------------------------

export const buildNestedCanvasFixture = (
  input: NestedCanvasPresetName | NestedCanvasSpec = "nested",
  overrides: Partial<NestedCanvasSpec> = {},
): NestedCanvasFixture => {
  const spec = { ...(typeof input === "string" ? NESTED_CANVAS_PRESETS[input] : input), ...overrides };
  const random = makeRandom(spec.seed);
  const plans = planRegions(spec, random);

  const groups: GroupNode[] = [];
  const members: CanvasNode[] = [];
  const seatsByRegion = new Map<string, string[]>();
  const counts = { seats: 0, notes: 0, terminals: 0, gits: 0 };
  let depth = 0;

  const placeMember = (kind: MemberKind, regionId: string, x: number, y: number): void => {
    switch (kind) {
      case "seat": {
        counts.seats += 1;
        const id = `seat-${counts.seats}`;
        members.push(
          agentTextNode({ id, key: `local:stress-${counts.seats}`, label: `seat ${counts.seats}`, x, y }),
        );
        seatsByRegion.get(regionId)!.push(id);
        return;
      }
      case "note": {
        counts.notes += 1;
        const text = NOTE_TEXT[counts.notes % NOTE_TEXT.length]!;
        members.push({ ...textNode(`note-${counts.notes}`, text, x, y), ...NOTE });
        return;
      }
      case "terminal": {
        counts.terminals += 1;
        members.push(
          terminalTextNode({
            id: `terminal-${counts.terminals}`,
            bindingId: `stress-terminal-${counts.terminals}`,
            label: `shell ${counts.terminals}`,
            x,
            y,
          }),
        );
        return;
      }
      case "git": {
        counts.gits += 1;
        const git: TextNode = {
          id: `git-${counts.gits}`,
          type: "text",
          text: `repo ${counts.gits}`,
          x,
          y,
          ...GIT,
          ether: { entity: { kind: "git" }, git: { cwd: "/tmp" } },
        };
        members.push(git);
        return;
      }
    }
  };

  const layout = (measured: Measured, x: number, y: number): void => {
    const { plan } = measured;
    depth = Math.max(depth, plan.level + 1);
    groups.push({
      id: plan.id,
      type: "group",
      label: plan.label,
      x,
      y,
      width: measured.width,
      height: measured.height,
      ...(plan.color ? { color: plan.color } : {}),
    });
    seatsByRegion.set(plan.id, []);
    const innerX = x + PAD;
    let cursorY = y + HEADER;
    plan.members.forEach((kind, index) => {
      placeMember(
        kind,
        plan.id,
        innerX + (index % MEMBER_COLS) * CELL_W,
        cursorY + Math.floor(index / MEMBER_COLS) * CELL_H,
      );
    });
    cursorY += measured.membersHeight + (measured.membersHeight > 0 ? CHILD_GAP : 0);
    for (const row of measured.rows) {
      let cursorX = innerX;
      let tallest = 0;
      for (const index of row) {
        const child = measured.children[index]!;
        layout(child, cursorX, cursorY);
        cursorX += child.width + CHILD_GAP;
        tallest = Math.max(tallest, child.height);
      }
      cursorY += tallest + CHILD_GAP;
    }
  };

  // Top-level regions in a loose grid, wider than tall like a real board.
  const tops = plans.map(measure);
  const perRow = Math.max(1, Math.ceil(Math.sqrt(tops.length * 1.6)));
  let rowY = 0;
  for (let start = 0; start < tops.length; start += perRow) {
    const row = tops.slice(start, start + perRow);
    let cursorX = 0;
    for (const top of row) {
      layout(top, cursorX, rowY);
      cursorX += top.width + TOP_GAP;
    }
    rowY += Math.max(...row.map((top) => top.height)) + TOP_GAP;
  }
  for (let i = 0; i < spec.looseNotes; i += 1) {
    counts.notes += 1;
    const text = NOTE_TEXT[counts.notes % NOTE_TEXT.length]!;
    members.push({ ...textNode(`note-${counts.notes}`, text, -NOTE.width - TOP_GAP, i * CELL_H), ...NOTE });
  }

  // Outer regions first: the canvas paints document order, parents under children.
  const nodes: CanvasNode[] = [...groups, ...members];
  const edges: CanvasEdge[] = [];
  const wired = new Set<string>();
  const wire = (from: string, to: string, verb: "messages" | "reviews"): void => {
    const key = `${from}>${to}`;
    if (from === to || wired.has(key)) return;
    wired.add(key);
    edges.push(verbEdge(`wire-${edges.length + 1}`, from, to, verb, nodes));
  };
  // Seats in a region relay down a chain; every region's head reaches each
  // child region's head, so wires cross every nesting boundary.
  const wireRegion = (plan: RegionPlan): string | undefined => {
    const seats = seatsByRegion.get(plan.id)!;
    for (let i = 0; i < seats.length - 1; i += 1) wire(seats[i]!, seats[i + 1]!, "messages");
    const childHeads = plan.children.map(wireRegion).filter((head): head is string => head !== undefined);
    const head = seats[0] ?? childHeads[0];
    childHeads.forEach((childHead, index) => {
      if (head) wire(head, childHead, index % 3 === 2 ? "reviews" : "messages");
    });
    return head;
  };
  plans.forEach(wireRegion);
  const allSeats = [...seatsByRegion.values()].flat();
  if (allSeats.length > 1) {
    for (let i = 0; i < spec.crossWires; i += 1) {
      const from = allSeats[Math.floor(random() * allSeats.length)]!;
      const to = allSeats[Math.floor(random() * allSeats.length)]!;
      wire(from, to, "messages");
    }
  }

  const signalSeats = allSeats.filter(() => random() < spec.signalFraction);

  return {
    doc: canvasDoc(nodes, edges),
    stats: {
      regions: groups.length,
      depth,
      ...counts,
      edges: edges.length,
      signals: signalSeats.length,
      bounds: boundsOf(nodes),
    },
    signals: openSignals(signalSeats),
  };
};

const boundsOf = (nodes: ReadonlyArray<CanvasNode>): NestedCanvasStats["bounds"] => {
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/** Fixed timestamps: the fixture never reads the clock. */
const openSignals =
  (seats: ReadonlyArray<string>) =>
  (canvasName: string): ReadonlyArray<AgentSignal> =>
    seats.map((nodeId, index) => ({
      signalId: `stress-signal-${index + 1}`,
      canvasName,
      nodeId,
      kind: (["escalate", "blocked", "feedback"] as const)[index % 3]!,
      text: "Need a decision before I go on",
      createdAt: 1_790_000_000_000 + index * 60_000,
      state: "open" as const,
    }));

/** Preset name plus per-field overrides; `{}` is the `nested` preset. */
export type NestedCanvasOptions = Partial<NestedCanvasSpec> & {
  readonly preset?: NestedCanvasPresetName;
};

/** The board as a CanvasDoc, for `launchJunto({ seedCanvases: { name: doc } })`. */
export const buildNestedCanvas = (options: NestedCanvasOptions = {}): CanvasDoc => {
  const { preset = "nested", ...overrides } = options;
  return buildNestedCanvasFixture(preset, overrides).doc;
};

// --- a real canvas's shape, from a database copy --------------------------------

const refuseLiveDatabase = (dbPath: string): string => {
  const absolute = resolve(dbPath);
  if (absolute.startsWith(resolve(homedir(), ".junto") + "/")) {
    throw new Error(
      `loadFactoryShapeCanvas reads a COPY of a Junto database, never the live one: ${absolute}`,
    );
  }
  return absolute;
};

interface ShapeNodeRow {
  readonly node_id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string | null;
  readonly kind: string | null;
}

interface ShapeEdgeRow {
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly verb: string | null;
}

/**
 * Rebuild `canvasName` from a read-only copy of a Junto database as a fixture
 * with the same geometry, nesting, region colours, z-order and wires. Agents
 * become fixture seats, terminals and git cards keep their kind, and every
 * other card becomes a note of the same size. Wires the fixture's cards do
 * not admit are dropped. Only ids, rects, colours, kinds and verbs are read.
 */
export const loadFactoryShapeCanvas = (input: {
  readonly dbPath: string;
  readonly canvasName?: string;
  readonly signalFraction?: number;
  readonly seed?: number;
}): NestedCanvasFixture => {
  const database = new DatabaseSync(refuseLiveDatabase(input.dbPath), { readOnly: true });
  let nodeRows: ReadonlyArray<ShapeNodeRow>;
  let edgeRows: ReadonlyArray<ShapeEdgeRow>;
  try {
    const canvas = database
      .prepare("SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?")
      .get(input.canvasName ?? "factory") as { canvas_id: string } | undefined;
    if (!canvas) throw new Error(`no canvas named ${input.canvasName ?? "factory"} in ${input.dbPath}`);
    nodeRows = database
      .prepare(
        `SELECT node_id, type, x, y, width, height,
                CASE WHEN type = 'group' THEN color ELSE NULL END AS color,
                json_extract(ether_json, '$.entity.kind') AS kind
           FROM canvas_nodes WHERE canvas_id = ? ORDER BY z_index`,
      )
      .all(canvas.canvas_id) as unknown as ReadonlyArray<ShapeNodeRow>;
    edgeRows = database
      .prepare(
        `SELECT from_node_id, to_node_id, json_extract(ether_json, '$.verb') AS verb
           FROM canvas_edges WHERE canvas_id = ? ORDER BY z_index`,
      )
      .all(canvas.canvas_id) as unknown as ReadonlyArray<ShapeEdgeRow>;
  } finally {
    database.close();
  }
  return rebuildShape(nodeRows, edgeRows, input.signalFraction ?? 0.1, input.seed ?? 4);
};

const rebuildShape = (
  nodeRows: ReadonlyArray<ShapeNodeRow>,
  edgeRows: ReadonlyArray<ShapeEdgeRow>,
  signalFraction: number,
  seed: number,
): NestedCanvasFixture => {
  const random = makeRandom(seed);
  const ids = new Map<string, string>();
  const counts = { regions: 0, seats: 0, notes: 0, terminals: 0, gits: 0 };
  const nodes: CanvasNode[] = nodeRows.map((row) => {
    const at = { x: Math.round(row.x), y: Math.round(row.y) };
    const size = { width: Math.round(row.width), height: Math.round(row.height) };
    if (row.type === "group") {
      counts.regions += 1;
      const id = `region-${counts.regions}`;
      ids.set(row.node_id, id);
      const group: GroupNode = {
        id,
        type: "group",
        label: REGION_WORDS[counts.regions % REGION_WORDS.length]!,
        ...at,
        ...size,
        ...(row.color ? { color: row.color } : {}),
      };
      return group;
    }
    if (row.kind === "agent") {
      counts.seats += 1;
      const id = `seat-${counts.seats}`;
      ids.set(row.node_id, id);
      return agentTextNode({ id, key: `local:stress-${counts.seats}`, label: `seat ${counts.seats}`, ...at });
    }
    if (row.kind === "terminal") {
      counts.terminals += 1;
      const id = `terminal-${counts.terminals}`;
      ids.set(row.node_id, id);
      return terminalTextNode({ id, bindingId: `stress-terminal-${counts.terminals}`, label: `shell ${counts.terminals}`, ...at });
    }
    if (row.kind === "git") {
      counts.gits += 1;
      const id = `git-${counts.gits}`;
      ids.set(row.node_id, id);
      return { id, type: "text", text: `repo ${counts.gits}`, ...at, ...GIT, ether: { entity: { kind: "git" }, git: { cwd: "/tmp" } } };
    }
    counts.notes += 1;
    const id = `note-${counts.notes}`;
    ids.set(row.node_id, id);
    return { ...textNode(id, NOTE_TEXT[counts.notes % NOTE_TEXT.length]!, at.x, at.y), ...size };
  });
  const kindOf = new Map(nodes.map((node) => [node.id, node.ether?.entity?.kind]));
  const edges: CanvasEdge[] = [];
  for (const row of edgeRows) {
    const from = ids.get(row.from_node_id);
    const to = ids.get(row.to_node_id);
    if (!from || !to || !row.verb) continue;
    if (!verbsForPair(kindOf.get(from), kindOf.get(to)).includes(row.verb as Verb)) continue;
    edges.push(verbEdge(`wire-${edges.length + 1}`, from, to, row.verb as Verb, nodes));
  }
  const groups = nodes.filter((node): node is GroupNode => node.type === "group");
  const inside = (outer: GroupNode, inner: GroupNode): boolean =>
    outer.id !== inner.id &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  const depth = groups.reduce(
    (deepest, group) => Math.max(deepest, 1 + groups.filter((outer) => inside(outer, group)).length),
    0,
  );
  const seats = nodes.filter((node) => node.ether?.entity?.kind === "agent").map((node) => node.id);
  const signalSeats = seats.filter(() => random() < signalFraction);
  return {
    doc: canvasDoc(nodes, edges),
    stats: {
      ...counts,
      depth,
      edges: edges.length,
      signals: signalSeats.length,
      bounds: boundsOf(nodes),
    },
    signals: openSignals(signalSeats),
  };
};
