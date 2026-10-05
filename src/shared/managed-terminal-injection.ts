/**
 * Operational notices for managed terminals: the compact lines Junto types
 * into a live seat, and the transport marker that tags them.
 *
 * Nothing here is doctrine and nothing here is sent at session start. A seat
 * loads its briefing with `junto onboard` (shared/seat-onboarding.ts); the
 * reference lives behind `junto docs` (shared/junto-doctrine.ts).
 *
 * - Mid-session map changes send a compact notice pointing at live grants
 *   (composeEdgeMapChangeNotice / planEdgeMapChanges).
 * - A seat that has not onboarded gets a one-sentence nudge at a completed turn.
 *
 * Never writes ~/.claude, ~/.codex, ~/.grok, ~/.hermes.
 */

import type { CanvasDoc } from "./canvas";
import type { Port } from "./physics/schema";
import type { CommandFamily } from "./seat-onboarding";

// ── Connected targets ──────────────────────────────────────────────────────

export type InjectionConnectedTarget = {
  readonly id: string;
  readonly kind?: string;
  readonly summary?: string;
  /** Canonical held grants. Missing or empty grants teach no actions. */
  readonly ports?: readonly Port[];
};

/** Kind labels for neighbor-change notices; these are not permission grants. */
export const KIND_TO_SLOT: Readonly<Record<string, CommandFamily | undefined>> = {
  task: "tasks",
  tasks: "tasks",
  artifacts: "artifacts",
  board: "board",
  pad: "pad",
  sheet: "sheet",
  agent: "msg",
  page: "browser",
};

// ── Operational notices ────────────────────────────────────────────────────

/**
 * The onboarding nudge: one sentence that explains itself to an agent that
 * has never heard of Junto. Typed into a seat's composer at a completed turn
 * (or when the operator asks), never at session start.
 */
export const buildOnboardNudge = (): string =>
  "This terminal is a seat on a Junto canvas. Run `junto onboard` to load your seat briefing.";

// ── Rising-edge slot injection (mid-session edge connect) ──────────────────

export type EdgeMapChange = {
  readonly seatId: string;
  readonly added: readonly InjectionConnectedTarget[];
  readonly removed: readonly InjectionConnectedTarget[];
};

/**
 * Compact connection-change notice: one line naming, by id and kind, what the
 * seat can now reach and no longer reach, and the command that shows what it
 * may do with each. Command recipes and contract tables are NOT in the notice.
 * Never a re-briefing: the briefing is `junto onboard`.
 */
export const composeEdgeMapChangeNotice = (change: EdgeMapChange): string => {
  const fmt = (targets: readonly InjectionConnectedTarget[]): string =>
    targets
      .map((t) => (t.kind ? `\`${t.id}\` (${t.kind})` : `\`${t.id}\``))
      .join(", ");
  const parts: string[] = [];
  if (change.added.length > 0) {
    parts.push(`You can now reach ${fmt(change.added)}.`);
  }
  if (change.removed.length > 0) {
    parts.push(`You can no longer reach ${fmt(change.removed)}.`);
  }
  if (parts.length === 0) {
    return "Your connections did not change. Run `junto capabilities` to see them.";
  }
  return `Your connections changed. ${parts.join(" ")} Run \`junto capabilities\` for details.`;
};

/**
 * The complete input this diff reads out of a document: every node's kind by
 * id, first-occurrence-wins exactly as `Array.prototype.find` resolved it.
 *
 * Built once per document instead of re-walked per edge endpoint. The old
 * shape put `doc.nodes.find` inside the per-edge loop and then again inside
 * `isSeat`, so one commit cost O(edges x nodes) — on a 96-node board that is
 * tens of thousands of id comparisons for a diff that is almost always empty.
 */
const kindsById = (doc: CanvasDoc): ReadonlyMap<string, string | undefined> => {
  const out = new Map<string, string | undefined>();
  for (const node of doc.nodes) {
    // First occurrence wins: `find` returned the first match, and a document
    // with a duplicated id must keep resolving to the same node it did.
    if (out.has(node.id)) continue;
    out.set(node.id, node.ether?.entity?.kind);
  }
  return out;
};

/**
 * True when the two documents carry the same adjacency input.
 *
 * `planEdgeMapChanges` reads exactly three things: the ordered edge endpoints,
 * and each node's id and entity kind in order. When all three match position
 * for position the diff is provably empty, which is why this can short-circuit
 * rather than merely hint. Positional (not set) comparison keeps it sound in
 * the other direction too: a reordered document simply falls through to the
 * full computation and gets the same answer it always did.
 *
 * This is the gate the recompute never had. A canvas commit fires the listener
 * for ANY authorial change, and the overwhelming majority of them are geometry
 * — a dragged node, a resized region — which cannot move a single edge grant.
 */
const sameEdgeMapInput = (a: CanvasDoc, b: CanvasDoc): boolean => {
  if (a === b) return true;
  if (a.edges.length !== b.edges.length) return false;
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.edges.length; i += 1) {
    const x = a.edges[i];
    const y = b.edges[i];
    if (x.fromNode !== y.fromNode || x.toNode !== y.toNode) return false;
    // A verb swap moves the compiled grant without moving any endpoint, so
    // the seat's edge map must be revised for it like any rewiring.
    if (x.ether?.verb !== y.ether?.verb) return false;
  }
  for (let i = 0; i < a.nodes.length; i += 1) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (x.id !== y.id) return false;
    if (x.ether?.entity?.kind !== y.ether?.entity?.kind) return false;
  }
  return true;
};

/**
 * Edge-map diff for actor seats: added AND removed slot-bearing neighbors.
 * Pure — no I/O. Callers skip when `previous` is missing (open / first paint).
 */
export const planEdgeMapChanges = (
  previous: CanvasDoc,
  next: CanvasDoc,
): ReadonlyArray<EdgeMapChange> => {
  if (sameEdgeMapInput(previous, next)) return [];

  const previousKinds = kindsById(previous);
  const nextKinds = kindsById(next);
  const adjacency = (
    doc: CanvasDoc,
    kinds: ReadonlyMap<string, string | undefined>,
  ): Map<string, InjectionConnectedTarget[]> => {
    const out = new Map<string, InjectionConnectedTarget[]>();
    for (const edge of doc.edges) {
      for (const [a, b] of [
        [edge.fromNode, edge.toNode],
        [edge.toNode, edge.fromNode],
      ] as const) {
        // Absent node and node-without-kind were both `continue` before and
        // stay both `continue` now: `get` returns undefined for either.
        const kind = kinds.get(b);
        if (kind === undefined || KIND_TO_SLOT[kind] === undefined) continue;
        const list = out.get(a);
        const target: InjectionConnectedTarget = { id: b, ...(kind !== undefined ? { kind } : {}) };
        if (list) list.push(target);
        else out.set(a, [target]);
      }
    }
    return out;
  };

  const before = adjacency(previous, previousKinds);
  const after = adjacency(next, nextKinds);
  const isSeat = (
    kinds: ReadonlyMap<string, string | undefined>,
    id: string,
  ): boolean => kinds.get(id) === "agent";
  const key = (t: InjectionConnectedTarget): string => `${t.kind ?? ""}:${t.id}`;
  const changes: EdgeMapChange[] = [];
  for (const seatId of new Set([...before.keys(), ...after.keys()])) {
    if (!isSeat(nextKinds, seatId) && !isSeat(previousKinds, seatId)) continue;
    const prev = new Set((before.get(seatId) ?? []).map(key));
    const nextSet = new Set((after.get(seatId) ?? []).map(key));
    const added = (after.get(seatId) ?? []).filter((t) => !prev.has(key(t)));
    const removed = (before.get(seatId) ?? []).filter((t) => !nextSet.has(key(t)));
    if (added.length === 0 && removed.length === 0) continue;
    changes.push({
      seatId,
      added: [...added].sort((a, b) => a.id.localeCompare(b.id)),
      removed: [...removed].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  return changes.sort((a, b) => a.seatId.localeCompare(b.seatId));
};

// ── Bootstrap marker ────────────────────────────────────────────────────
// Marker: transport tag for echo-tracking typed payloads, never content.

/**
 * Marker prefix for bootstrap charters. Each binding gets a deterministic
 * 8-hex digest suffix, so a seat can recognize its own charter across
 * re-injections without the marker exposing the binding itself.
 */
export const BOOTSTRAP_MARKER_PREFIX = "[vc-";

/**
 * Deterministic per-binding marker: `[vc-<fnv1a64(bindingId)[0..8]>]`.
 * Pure JS (BigInt FNV-1a 64) — no node:crypto, so this module stays
 * importable from the renderer bundle (node:crypto is externalized by Vite).
 * The marker is a transport tag for echo-tracking typed payloads, not
 * doctrine content; collisions only mean two seats share an echo token.
 */
const fnv1a64Hex = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0").slice(0, 8);
};

export const buildBootstrapMarker = (bindingId: string): string =>
  `${BOOTSTRAP_MARKER_PREFIX}${fnv1a64Hex(bindingId)}]`;

/**
 * Prefix the payload with the seat marker. A one-line body stays one line
 * (`[vc-…] body`) so ink TUIs do not collapse the notice into a
 * `[Pasted text #N]` chip. Multiline bodies keep the marker on the first
 * line — never a blank separator that forces an extra chip line.
 */
export const appendBootstrapMarker = (
  text: string,
  bindingId: string,
): string => {
  const marker = buildBootstrapMarker(bindingId);
  const body = text.trim();
  if (!body.includes("\n")) return `${marker} ${body}`;
  return `${marker}\n${body}`;
};
