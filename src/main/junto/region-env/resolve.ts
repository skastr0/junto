/**
 * Region environment — the resolving half.
 *
 * `shared/region-environment.ts` decides WHICH sources apply to a seat and in
 * what order. This module walks that plan through a resolver (the stores are
 * `./sources.ts`), merges what came back, and hands a launch the values it
 * needs for one spawn.
 *
 * Values exist here only as the return value of `resolve*`, on their way to
 * the child's environment. Nothing in this module logs, stores or reports
 * one: the report and the launch record carry names and identities only.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CanvasDoc } from "@shared/canvas";
import {
  launchRecordOf,
  mergeRegionEnvironment,
  planRegionEnvironment,
  type EnvSourceResolver,
  type RegionEnvironmentLaunchRecord,
  type RegionEnvironmentPlan,
  type RegionEnvironmentTarget,
  type SourceReport,
  type SourceResolution,
} from "@shared/region-environment";

export type ResolvedRegionEnvironment = {
  /** Names to values, for the spawn only. */
  readonly env: Readonly<Record<string, string>>;
  /** Region folders as absolute paths. */
  readonly folders: ReadonlyArray<string>;
  /** One entry per source in scope, in application order. */
  readonly report: ReadonlyArray<SourceReport>;
  /** Region ids in scope, outermost first. */
  readonly regions: ReadonlyArray<string>;
  /** What a launch on this resolution was launched with. Holds no value. */
  readonly record: RegionEnvironmentLaunchRecord;
  /** Set when a `required` source could not be read: do not launch. */
  readonly refusal?: string;
};

/** `~` and `~/x` are the operator's home; anything else must be absolute. */
const absoluteFolder = (folder: string, home: string): string | undefined => {
  if (folder === "~") return home;
  if (folder.startsWith("~/")) return join(home, folder.slice(2));
  return isAbsolute(folder) ? folder : undefined;
};

/**
 * Resolve every source in the plan, in application order. A source sees what
 * every earlier source in scope produced (1Password takes its service-account
 * token that way), including one that a later source overrides by name.
 *
 * Total: a resolver that throws or rejects, against its contract, becomes an
 * `error` outcome for that one source. A launch is never crashed from here.
 */
const walk = async (
  plan: RegionEnvironmentPlan,
  resolver: EnvSourceResolver,
): Promise<Map<string, SourceResolution>> => {
  const outcomes = new Map<string, SourceResolution>();
  // Latest earlier source wins a shared id, so an inner region's source
  // answers before an outer region's of the same name.
  const valuesById = new Map<string, Readonly<Record<string, string>>>();
  for (const planned of plan.sources) {
    if (planned.skippedHost) continue;
    let outcome: SourceResolution;
    try {
      outcome = await resolver.resolve(planned.source, {
        resolved: (sourceId) => valuesById.get(sourceId),
      });
    } catch {
      // The cause is deliberately not read: it may quote what it was given.
      outcome = {
        status: "error",
        names: [...resolver.staticNamesOf(planned.source)],
        reason: "This source could not be read",
      };
    }
    outcomes.set(planned.key, outcome);
    if (outcome.status === "ok") valuesById.set(planned.source.id, outcome.values);
    else valuesById.delete(planned.source.id);
  }
  return outcomes;
};

/**
 * What the plan DECLARES, as a launch record: every source that names its
 * variable is taken at its word, and a source whose names live in a file
 * (`envFile`, `secretsDir`) contributes the names it actually has. Values are
 * dropped on the spot.
 *
 * A launch and a later "is this seat current?" check both build their record
 * this way, so the two compare like for like: a Keychain item that was
 * missing at launch and is still missing is not a difference, and telling
 * whether a seat is current never reads a secret.
 */
const declaredRecord = (
  plan: RegionEnvironmentPlan,
  resolver: EnvSourceResolver,
  dynamicNames: (key: string) => ReadonlyArray<string>,
): RegionEnvironmentLaunchRecord => {
  const declared = new Map<string, SourceResolution>();
  for (const planned of plan.sources) {
    if (planned.skippedHost) continue;
    const named = resolver.staticNamesOf(planned.source);
    const names = named.length > 0 ? named : dynamicNames(planned.key);
    declared.set(planned.key, {
      status: "ok",
      values: Object.fromEntries(names.map((name) => [name, ""])),
    });
  }
  return launchRecordOf(plan, mergeRegionEnvironment(plan, declared));
};

const okNames = (outcome: SourceResolution | undefined): ReadonlyArray<string> =>
  outcome?.status === "ok" ? Object.keys(outcome.values) : [];

export const resolvePlan = async (
  plan: RegionEnvironmentPlan,
  resolver: EnvSourceResolver,
  home: string = homedir(),
): Promise<ResolvedRegionEnvironment> => {
  const outcomes = await walk(plan, resolver);
  const merged = mergeRegionEnvironment(plan, outcomes, resolver.staticNamesOf);
  return {
    env: merged.env,
    folders: plan.folders.flatMap((folder) => {
      const absolute = absoluteFolder(folder, home);
      return absolute === undefined ? [] : [absolute];
    }),
    report: merged.report,
    regions: plan.regions.map((region) => region.regionId),
    record: declaredRecord(plan, resolver, (key) => okNames(outcomes.get(key))),
    ...(merged.refusal !== undefined ? { refusal: merged.refusal } : {}),
  };
};

/**
 * The record a seat WOULD be launched with now, without reading any secret.
 * Only sources whose names live in a local file are resolved.
 */
export const currentLaunchRecord = async (
  plan: RegionEnvironmentPlan,
  resolver: EnvSourceResolver,
): Promise<RegionEnvironmentLaunchRecord> => {
  const dynamic = new Map<string, ReadonlyArray<string>>();
  for (const planned of plan.sources) {
    if (planned.skippedHost) continue;
    if (resolver.staticNamesOf(planned.source).length > 0) continue;
    try {
      dynamic.set(
        planned.key,
        okNames(
          await resolver.resolve(planned.source, { resolved: () => undefined }),
        ),
      );
    } catch {
      // Unreadable now: it provides no names now.
    }
  }
  return declaredRecord(plan, resolver, (key) => dynamic.get(key) ?? []);
};

/**
 * The spec's entry point, bound to one resolver. `target` is a seat (with its
 * live rect when the caller has one) or a region, read as a seat placed
 * directly inside it.
 */
export const makeRegionEnvironmentResolution = (
  resolver: EnvSourceResolver,
  home: string = homedir(),
) => ({
  plan: planRegionEnvironment,
  resolve: (
    doc: CanvasDoc,
    target: RegionEnvironmentTarget,
    hostId: string,
  ): Promise<ResolvedRegionEnvironment> =>
    resolvePlan(planRegionEnvironment(doc, target, hostId), resolver, home),
  current: (
    doc: CanvasDoc,
    target: RegionEnvironmentTarget,
    hostId: string,
  ): Promise<RegionEnvironmentLaunchRecord> =>
    currentLaunchRecord(planRegionEnvironment(doc, target, hostId), resolver),
});

export type RegionEnvironmentResolution = ReturnType<
  typeof makeRegionEnvironmentResolution
>;
