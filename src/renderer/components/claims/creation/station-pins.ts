/**
 * Pure pin bookkeeping for the creation metro map. A pin is a station-addressed
 * claim (`TaskClaim`) the raiser attaches to one stop on the line; it is
 * answered when the journey reaches that stop, or fork-waived if the chosen
 * branch abandons it. Nothing here judges a claim — pins are prompts.
 */

import type { EffectiveClaim } from "@shared/claims";
import type { ClaimDef, TaskClaim } from "@shared/work-model";
import type { StationStop } from "./station-map";

/** Standing claims in first-seen order, deduplicated across every stop. */
export const lineLaw = (
  line: ReadonlyArray<StationStop>,
): ReadonlyArray<EffectiveClaim> => {
  const seen = new Set<string>();
  const law: EffectiveClaim[] = [];
  for (const stop of line) {
    for (const entry of stop.law) {
      if (seen.has(entry.claim.id)) continue;
      seen.add(entry.claim.id);
      law.push(entry);
    }
  }
  return law;
};

export const REGION_LAW_SCOPE =
  "asked when work completes at a stop it covers";
export const SINK_LAW_SCOPE = "asked when work completes at this station";

/**
 * Standing law split by provenance. Region claims keep their region name;
 * sink claims keep the station they bind at. The kernel evaluates each
 * completing station's own stack — a fork that skips a sink never asks
 * that sink's claims, and hard region claims are re-demanded at every
 * covered completion.
 */
export type LineLawGroup = {
  readonly kind: "region" | "sink";
  readonly id: string;
  readonly label: string;
  readonly scope: string;
  readonly claims: ReadonlyArray<EffectiveClaim>;
};

export const groupLineLaw = (
  line: ReadonlyArray<StationStop>,
): ReadonlyArray<LineLawGroup> => {
  const groups: LineLawGroup[] = [];
  const indexByKey = new Map<string, number>();
  const seenClaim = new Set<string>();
  for (const stop of line) {
    for (const entry of stop.law) {
      if (entry.provenance.kind === "task") continue;
      const key =
        entry.provenance.kind === "region"
          ? `region:${entry.provenance.regionId}`
          : `sink:${entry.provenance.nodeId}`;
      const claimKey = `${key}:${entry.claim.id}`;
      if (seenClaim.has(claimKey)) continue;
      seenClaim.add(claimKey);
      const existing = indexByKey.get(key);
      if (existing !== undefined) {
        const group = groups[existing]!;
        groups[existing] = {
          ...group,
          claims: [...group.claims, entry],
        };
        continue;
      }
      indexByKey.set(key, groups.length);
      groups.push({
        kind: entry.provenance.kind,
        id: key,
        label:
          entry.provenance.kind === "region"
            ? entry.provenance.label
            : stop.label,
        scope:
          entry.provenance.kind === "region"
            ? REGION_LAW_SCOPE
            : SINK_LAW_SCOPE,
        claims: [entry],
      });
    }
  }
  return groups;
};

export type StationHop = {
  readonly hops: number;
  /** Parent station ids that forward here, document order, joined for grouping. */
  readonly parents: ReadonlyArray<string>;
  readonly stops: ReadonlyArray<StationStop>;
};

const parentsOf = (
  line: ReadonlyArray<StationStop>,
  nodeId: string,
): ReadonlyArray<string> =>
  line
    .filter((stop) => stop.destinations.includes(nodeId))
    .map((stop) => stop.nodeId);

const sameParents = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Compact rail columns. Same-distance stops share a branch column only when
 * they share the same parents — a true fork. Parallel chains at the same hop
 * stay separate so the rail does not invent a common fork.
 */
export const groupStopsByHop = (
  line: ReadonlyArray<StationStop>,
): ReadonlyArray<StationHop> => {
  const groups: StationHop[] = [];
  for (const stop of line) {
    const parents = parentsOf(line, stop.nodeId);
    const current = groups.at(-1);
    if (
      current !== undefined &&
      current.hops === stop.hops &&
      sameParents(current.parents, parents)
    ) {
      groups[groups.length - 1] = {
        ...current,
        stops: [...current.stops, stop],
      };
    } else {
      groups.push({ hops: stop.hops, parents, stops: [stop] });
    }
  }
  return groups;
};

/** Pins addressed to one stop, in authoring order. */
export const pinsAt = (
  pins: ReadonlyArray<TaskClaim>,
  station: string,
): ReadonlyArray<TaskClaim> => pins.filter((pin) => pin.station === station);

/** The same pins as plain claims, for the shared claims editor. */
export const claimsAt = (
  pins: ReadonlyArray<TaskClaim>,
  station: string,
): ReadonlyArray<ClaimDef> =>
  pinsAt(pins, station).map(({ station: _station, ...claim }) => claim);

/**
 * Replace every pin at one station, leaving the other stations untouched.
 * Order is preserved: the station's new pins land where its old ones sat, so
 * an edit never reshuffles the authored profile.
 */
export const replacePinsAt = (
  pins: ReadonlyArray<TaskClaim>,
  station: string,
  claims: ReadonlyArray<ClaimDef>,
): ReadonlyArray<TaskClaim> => {
  const incoming = claims.map((claim) => ({ ...claim, station }));
  const out: TaskClaim[] = [];
  let placed = false;
  for (const pin of pins) {
    if (pin.station !== station) {
      out.push(pin);
      continue;
    }
    if (placed) continue;
    out.push(...incoming);
    placed = true;
  }
  if (!placed) out.push(...incoming);
  return out;
};

/**
 * Pins addressed to a stop the line no longer reaches — the flow graph changed
 * while the composer was open. An unanswerable claim is never carried silently.
 */
export const strandedPins = (
  pins: ReadonlyArray<TaskClaim>,
  line: ReadonlyArray<StationStop>,
): ReadonlyArray<TaskClaim> => {
  const stops = new Set(line.map((stop) => stop.nodeId));
  return pins.filter((pin) => !stops.has(pin.station));
};

/** Drop the stranded pins, keeping the rest in authoring order. */
export const pruneToLine = (
  pins: ReadonlyArray<TaskClaim>,
  line: ReadonlyArray<StationStop>,
): ReadonlyArray<TaskClaim> => {
  const stops = new Set(line.map((stop) => stop.nodeId));
  return pins.filter((pin) => stops.has(pin.station));
};

/** One-look rigor profile of the whole line, standing law plus pins. */
export type LineProfile = {
  readonly stops: number;
  readonly standing: number;
  readonly hard: number;
  readonly soft: number;
  readonly pinned: number;
};

export const lineProfile = (
  line: ReadonlyArray<StationStop>,
  pins: ReadonlyArray<TaskClaim> = [],
): LineProfile => {
  const onLine = pruneToLine(pins, line);
  const standing = lineLaw(line);
  return {
    stops: line.length,
    standing: standing.length,
    hard:
      standing.filter((entry) => entry.claim.severity === "hard").length +
      onLine.filter((pin) => pin.severity === "hard").length,
    soft:
      standing.filter((entry) => entry.claim.severity === "soft").length +
      onLine.filter((pin) => pin.severity === "soft").length,
    pinned: onLine.length,
  };
};

/** The profile in words: "4 stops, 9 claims, 6 hard". */
export const formatProfile = (profile: LineProfile): string => {
  const claims = profile.standing + profile.pinned;
  const stops = `${profile.stops} ${profile.stops === 1 ? "stop" : "stops"}`;
  if (claims === 0) return `${stops}, no standing claims`;
  return `${stops}, ${claims} ${claims === 1 ? "claim" : "claims"}, ${profile.hard} hard`;
};
