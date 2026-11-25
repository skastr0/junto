/**
 * A seat's connections, as its Connections list reads them: every wire that
 * touches the seat, one row each, whatever is at the other end, grouped by the
 * other end's region. Read from the canvas as it stands; nothing is stored.
 * Adding and removing go through the canvas's own wire changes
 * (`edge-mutations.ts`), so undo and authoring hold as for a wire removed on
 * the canvas.
 */
import { asNodeId, type Canvas, type Node, type Wire } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { regionTrails, trailPath, type RegionStep } from "./region-path";
import { verbSentence } from "./verb-sentence";

/** Which way this one wire goes from the seat: out to the other end, or in from it. A pair wired both ways is two rows. */
export type ConnectionWay = "out" | "in";

export type SeatConnection = {
  readonly wireId: string;
  /** The other end of the wire. */
  readonly other: Node;
  readonly otherName: string;
  /** The other end's regions, outermost first; empty in the open field. */
  readonly trail: ReadonlyArray<RegionStep>;
  readonly path: string;
  /** The wire said as the bar says it: "product-lead messages cli-lead". */
  readonly sentence: string;
  readonly way: ConnectionWay;
};

export type ConnectionGroup = {
  /** The other ends' innermost region; null for the open field. */
  readonly regionId: string | null;
  readonly name: string;
  /** The regions around it, outermost first. */
  readonly outer: ReadonlyArray<string>;
  readonly color?: string;
  readonly rows: ReadonlyArray<SeatConnection>;
};

/** The name the open field is grouped under. */
export const OPEN_FIELD = "Open field";

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Every wire that touches the seat, one row each, by the other end's name. */
export const seatConnections = (canvas: Canvas, seatId: string): ReadonlyArray<SeatConnection> => {
  const seat = canvas.nodes.get(asNodeId(seatId));
  if (seat === undefined) return [];
  const trails = regionTrails(canvas);
  const touching: Wire[] = [];
  for (const wire of canvas.wires.values()) if (wire.from === seatId || wire.to === seatId) touching.push(wire);
  const rows: SeatConnection[] = [];
  for (const wire of touching) {
    const otherId = wire.from === seatId ? wire.to : wire.from;
    // A wire from the seat to itself is not drawn; one whose other end is gone has nothing to list.
    if (otherId === seatId) continue;
    const other = canvas.nodes.get(asNodeId(otherId));
    if (other === undefined) continue;
    const from = wire.from === seatId ? seat : other;
    const to = wire.from === seatId ? other : seat;
    const trail = trails.get(other.id) ?? [];
    rows.push({
      wireId: wire.id,
      other,
      otherName: titleOf(other),
      trail,
      path: trailPath(trail),
      sentence: wire.verb === undefined ? `${titleOf(from)} to ${titleOf(to)}` : verbSentence(wire.verb, titleOf(from), titleOf(to)),
      way: wire.from === seatId ? "out" : "in",
    });
  }
  return rows.sort((a, b) => byName(a.otherName, b.otherName) || byName(a.sentence, b.sentence) || a.wireId.localeCompare(b.wireId));
};

/** How many rows the seat's list shows, the count its bar key says, without reading any region. */
export const connectionCount = (canvas: Canvas, seatId: string): number => {
  if (!canvas.nodes.has(asNodeId(seatId))) return 0;
  let count = 0;
  for (const wire of canvas.wires.values()) {
    const otherId = wire.from === seatId ? wire.to : wire.to === seatId ? wire.from : undefined;
    if (otherId !== undefined && otherId !== seatId && canvas.nodes.has(asNodeId(otherId))) count += 1;
  }
  return count;
};

/** Rows whose other end's name or region path holds the search, ignoring case. */
export const matchConnections = (rows: ReadonlyArray<SeatConnection>, search: string): ReadonlyArray<SeatConnection> => {
  const needle = search.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) => `${row.otherName} ${row.path}`.toLowerCase().includes(needle));
};

/**
 * Rows by the other end's innermost region: the seat's own region first, then
 * by name, the open field last. A group with no row is not made.
 */
export const groupConnections = (
  canvas: Canvas,
  seatId: string,
  rows: ReadonlyArray<SeatConnection>,
): ReadonlyArray<ConnectionGroup> => {
  const own = regionTrails(canvas).get(seatId)?.at(-1)?.id ?? null;
  const groups = new Map<string | null, { group: Omit<ConnectionGroup, "rows">; rows: SeatConnection[] }>();
  for (const row of rows) {
    const inner = row.trail.at(-1);
    const regionId = inner?.id ?? null;
    let held = groups.get(regionId);
    if (held === undefined) {
      held = {
        group: {
          regionId,
          name: inner?.name ?? OPEN_FIELD,
          outer: row.trail.slice(0, -1).map((step) => step.name),
          ...(inner?.color === undefined ? {} : { color: inner.color }),
        },
        rows: [],
      };
      groups.set(regionId, held);
    }
    held.rows.push(row);
  }
  const place = (group: Omit<ConnectionGroup, "rows">): number =>
    group.regionId === own && own !== null ? 0 : group.regionId === null ? 2 : 1;
  return [...groups.values()]
    .map(({ group, rows: held }) => ({ ...group, rows: held }))
    .sort((a, b) => place(a) - place(b) || byName(a.name, b.name) || byName(a.outer.join("/"), b.outer.join("/")));
};
