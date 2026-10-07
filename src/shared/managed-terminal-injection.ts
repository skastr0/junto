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

import { asNodeId, type Canvas } from "./model";
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

/** Geometry and unrelated node fields cannot change the connection map. */
const sameEdgeMapInput = (a: Canvas, b: Canvas): boolean => {
  if (a === b) return true;
  if (a.wires.size !== b.wires.size || a.nodes.size !== b.nodes.size) return false;
  for (const [id, wire] of a.wires) {
    const other = b.wires.get(id);
    if (!other || wire.from !== other.from || wire.to !== other.to || wire.verb !== other.verb) return false;
  }
  for (const [id, node] of a.nodes) {
    if (node.kind !== b.nodes.get(id)?.kind) return false;
  }
  return true;
};

/**
 * Edge-map diff for actor seats: added AND removed slot-bearing neighbors.
 * Pure — no I/O. Callers skip when `previous` is missing (open / first paint).
 */
export const planEdgeMapChanges = (
  previous: Canvas,
  next: Canvas,
): ReadonlyArray<EdgeMapChange> => {
  if (sameEdgeMapInput(previous, next)) return [];

  const adjacency = (
    canvas: Canvas,
  ): Map<string, InjectionConnectedTarget[]> => {
    const out = new Map<string, InjectionConnectedTarget[]>();
    for (const edge of canvas.wires.values()) {
      for (const [a, b] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ] as const) {
        const kind = canvas.nodes.get(b)?.kind;
        if (kind === undefined || KIND_TO_SLOT[kind] === undefined) continue;
        const list = out.get(a);
        const target: InjectionConnectedTarget = { id: b, ...(kind !== undefined ? { kind } : {}) };
        if (list) list.push(target);
        else out.set(a, [target]);
      }
    }
    return out;
  };

  const before = adjacency(previous);
  const after = adjacency(next);
  const isSeat = (
    canvas: Canvas,
    id: string,
  ): boolean => canvas.nodes.get(asNodeId(id))?.kind === "agent";
  const key = (t: InjectionConnectedTarget): string => `${t.kind ?? ""}:${t.id}`;
  const changes: EdgeMapChange[] = [];
  for (const seatId of new Set([...before.keys(), ...after.keys()])) {
    if (!isSeat(next, seatId) && !isSeat(previous, seatId)) continue;
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
