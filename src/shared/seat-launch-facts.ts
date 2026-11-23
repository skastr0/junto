/**
 * What a seat runs, as the facts the operator reads about it: the harness,
 * every dial that harness declares, and where the seat lives.
 *
 * These are launch facts. The seat's launch argv is the one stored form of
 * its dials, so each value here is what the seat was started with. No seat
 * reports the model it is running now, and nothing here pretends to: a dial
 * the seat does not set reads "harness default", which means the harness's
 * own config decides.
 */
import type { HarnessParamKey } from "./harness-domain";
import { HARNESS_RECORDS, profileFromAgentKey } from "./harness-records";
import { recoverDocumentLaunchChoices } from "./launch-choices";
import { templateFor } from "./managed-terminal-templates";
import type { Seat } from "./model";

export type SeatLaunchFactKey = "harness" | HarnessParamKey | "machine" | "folder";

export type SeatLaunchFact = {
  readonly key: SeatLaunchFactKey;
  readonly label: string;
  readonly value: string;
  /** The seat sets nothing for this dial: the harness's own config decides. */
  readonly harnessDefault?: true;
};

/** What a dial the seat leaves unset reads. */
export const HARNESS_DEFAULT = "harness default";

/** The dials before profile and provider, in the harness's display order. */
const LEADING_DIALS: ReadonlySet<HarnessParamKey> = new Set(["model", "effort", "mode", "permissionMode"]);

type SeatLaunchSource = Pick<Seat, "harness" | "host" | "agentKey" | "launch">;

/**
 * The seat's launch facts, in reading order: the harness's display name, each
 * dial it declares (model, effort, mode, permission mode) with its stored
 * value or "harness default", then profile and provider the same way, extra
 * arguments when there are any, the machine, and the folder.
 *
 * An effort that rides inside the model id (Cursor) has no value of its own:
 * with a model set the model carries it and no effort fact is given.
 */
export const seatLaunchFacts = (
  seat: SeatLaunchSource,
  options: { readonly machine?: (host: string) => string } = {},
): readonly SeatLaunchFact[] => {
  const harness = seat.harness;
  const record = HARNESS_RECORDS[harness];
  const recovered = recoverDocumentLaunchChoices(harness, seat.launch);
  const stored: Partial<Record<HarnessParamKey, string>> = {
    ...(recovered.model ? { model: recovered.model } : {}),
    ...(recovered.effort ? { effort: recovered.effort } : {}),
    ...(recovered.mode ? { mode: recovered.mode } : {}),
    ...(recovered.permissionMode ? { permissionMode: recovered.permissionMode } : {}),
    ...(recovered.provider ? { provider: recovered.provider } : {}),
  };
  const profile = recovered.profile ?? profileFromAgentKey(harness, seat.agentKey);
  if (profile) stored.profile = profile;

  const dial = (key: HarnessParamKey, label: string): SeatLaunchFact => {
    const value = stored[key];
    return value
      ? { key, label, value }
      : { key, label, value: HARNESS_DEFAULT, harnessDefault: true };
  };

  const params = record.params.params;
  const facts: SeatLaunchFact[] = [{ key: "harness", label: "Harness", value: templateFor(harness).displayName }];
  for (const spec of params) {
    if (!LEADING_DIALS.has(spec.key)) continue;
    if (spec.key === "effort" && spec.emit.via === "modelSlug" && stored.model) continue;
    facts.push(dial(spec.key, spec.label));
  }
  for (const key of ["profile", "provider"] as const) {
    const spec = params.find((candidate) => candidate.key === key);
    if (spec) facts.push(dial(key, spec.label));
  }
  const extraArgs = recovered.extraArgs ?? [];
  if (extraArgs.length > 0) {
    const label = params.find((spec) => spec.key === "extraArgs")?.label ?? "Extra arguments";
    facts.push({ key: "extraArgs", label, value: extraArgs.join(" ") });
  }
  facts.push({ key: "machine", label: "Machine", value: options.machine?.(seat.host) ?? seat.host });
  const folder = seat.launch?.cwd?.trim();
  if (folder) facts.push({ key: "folder", label: "Folder", value: folder });
  return facts;
};

/** The facts that say how a seat is launched: everything but where it lives. */
const isLaunchConfiguration = (fact: SeatLaunchFact): boolean =>
  fact.key !== "machine" && fact.key !== "folder";

/** One launch configuration shared by some of the selected seats. */
export type LaunchConfigurationTally = {
  /** Equal for two seats exactly when they are launched the same way. */
  readonly key: string;
  /** The harness, then each dial the seats set, in reading order. */
  readonly summary: string;
  readonly count: number;
  readonly seatIds: readonly string[];
};

/**
 * Seats grouped by how they are launched, most seats first. Two seats are in
 * one group when their harness and every dial match; machine and folder do
 * not count. A group's summary names the harness and the dials it sets, or
 * says "harness defaults" when it sets none.
 */
export const tallyLaunchConfigurations = (
  seats: ReadonlyArray<SeatLaunchSource & { readonly id: string }>,
): readonly LaunchConfigurationTally[] => {
  const groups = new Map<string, { summary: string; seatIds: string[] }>();
  for (const seat of seats) {
    const facts = seatLaunchFacts(seat).filter(isLaunchConfiguration);
    const key = JSON.stringify(facts.map((fact) => [fact.key, fact.harnessDefault ? null : fact.value]));
    const group = groups.get(key);
    if (group) {
      group.seatIds.push(seat.id);
      continue;
    }
    const [harness, ...dials] = facts;
    const set = dials.filter((fact) => !fact.harnessDefault).map((fact) => fact.value);
    const summary = [harness?.value ?? seat.harness, ...(set.length > 0 ? set : ["harness defaults"])].join(", ");
    groups.set(key, { summary, seatIds: [seat.id] });
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, summary: group.summary, count: group.seatIds.length, seatIds: group.seatIds }))
    .sort((left, right) => right.count - left.count || left.summary.localeCompare(right.summary));
};
