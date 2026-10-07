/**
 * Region environment — the pure half.
 *
 * A region (group node) may carry an `environment`. A seat's environment is
 * resolved AT LAUNCH from every region that contains the seat at that moment;
 * membership is geometric, the same `regionStack` every other region law uses.
 *
 * The law, all of it decided here and nowhere else:
 *
 * - Nesting: regions apply outermost first. An inner region adds to the outer
 *   and overrides it by variable name.
 * - `sealed: true` cuts the stack: seats inside inherit nothing from regions
 *   outside the sealed one.
 * - Within one region, sources apply in list order; a later source overrides
 *   an earlier one by name.
 * - A source with a `host` applies only on that machine.
 * - Junto's own variables always win: a region cannot set a `JUNTO_*` name,
 *   a nested-session marker Junto strips from every seat, or the terminal
 *   type. Such a name is reported, never silently dropped.
 * - A source that cannot be read never crashes a launch. The seat starts
 *   without it and the report says so; `required: true` refuses the launch.
 *
 * This module reads no store and no file. It produces the ordered plan of
 * sources, and given what each source resolved to, merges the values and
 * writes the report. Reading the stores is the main process's job
 * (`main/junto/region-env`), behind `EnvSourceResolver`.
 *
 * Renderer-safe: no Node imports.
 */
import { Schema } from "effect";
import {
  EnvSource,
  EtherRegionEnvironment,
  type CanvasDoc,
  type EnvSourceKind,
  type GroupNode,
} from "./canvas";
import {
  isGroup,
  regionDisplayName,
  regionStack,
  type RegionRect,
} from "./graph";
import { DEFAULT_STATION_HOST_ID } from "./station";
import {
  SPAWN_ENV_SCRUB,
  SPAWN_ENV_SCRUB_PREFIXES,
} from "./managed-terminal-templates";

export { EnvSource, EtherRegionEnvironment };
export type { EnvSourceKind };

// ── report (names, kinds, origins and status; never a value) ───────────────

export const SourceReportStatus = Schema.Literals([
  "ok",
  "missing",
  "error",
  "skipped-host",
  "overridden",
]);
export type SourceReportStatus = typeof SourceReportStatus.Type;

export const SourceReport = Schema.Struct({
  regionId: Schema.String,
  regionLabel: Schema.String,
  sourceId: Schema.String,
  kind: Schema.Literals([
    "value",
    "secret",
    "keychain",
    "keyring",
    "onepassword",
    "envFile",
    "secretsDir",
    "command",
  ]),
  /** Variable names this source provides to the seat. Never values. */
  names: Schema.Array(Schema.String),
  status: SourceReportStatus,
  /** Plain words, no secret material. */
  reason: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
});
export type SourceReport = typeof SourceReport.Type;

/** One seat's resolution: what `env.report` on the work socket returns. */
export const SeatEnvironmentReport = Schema.Struct({
  nodeId: Schema.String,
  title: Schema.String,
  /** Regions in scope, outermost first. */
  regions: Schema.Array(Schema.String),
  /** One entry per source in scope, in application order. */
  report: Schema.Array(SourceReport),
  /** Extra directories in scope, as the document writes them. */
  folders: Schema.Array(Schema.String),
  /** The seat is running on a resolution that differs from this one. */
  restartToApply: Schema.Boolean,
});
export type SeatEnvironmentReport = typeof SeatEnvironmentReport.Type;

/** A region's resolution: a seat placed directly inside it. */
export const RegionEnvironmentEntry = Schema.Struct({
  regionId: Schema.String,
  regionLabel: Schema.String,
  sealed: Schema.Boolean,
  sources: Schema.Array(SourceReport),
});
export type RegionEnvironmentEntry = typeof RegionEnvironmentEntry.Type;

/** The canvas-wide report: every region with an environment, every seat. */
export const RegionEnvironmentReport = Schema.Struct({
  regions: Schema.Array(RegionEnvironmentEntry),
  seats: Schema.Array(SeatEnvironmentReport),
});
export type RegionEnvironmentReport = typeof RegionEnvironmentReport.Type;

/** A running seat whose launch environment differs from the current resolution. */
export type StaleSeat = {
  readonly seatId: string;
  readonly title: string;
  /** Variable NAMES that would differ after a restart. Never values. */
  readonly changed: ReadonlyArray<string>;
};

// ── resolver contract (implemented in main/junto/region-env/sources.ts) ────

export type SourceResolution =
  /** Names to values, for the spawn only. */
  | { readonly status: "ok"; readonly values: Readonly<Record<string, string>> }
  /** The item, file or path is not there. */
  | {
      readonly status: "missing";
      readonly names: ReadonlyArray<string>;
      readonly reason: string;
    }
  /** The store or tool failed, timed out, or needs the operator. */
  | {
      readonly status: "error";
      readonly names: ReadonlyArray<string>;
      readonly reason: string;
    };

export type SourceContext = {
  /**
   * Values an earlier source in scope produced, by source id. An overridden
   * source still answers; a source skipped for its host, a later source and a
   * source outside the scope answer undefined.
   */
  readonly resolved: (
    sourceId: string,
  ) => Readonly<Record<string, string>> | undefined;
};

/**
 * Where values come from. Never rejects and never throws into a launch;
 * every external call is bounded by a timeout; reasons carry no secret.
 */
export type EnvSourceResolver = {
  readonly resolve: (
    source: EnvSource,
    context: SourceContext,
  ) => Promise<SourceResolution>;
  /** Names known without resolving (empty for envFile and secretsDir). */
  readonly staticNamesOf: (source: EnvSource) => ReadonlyArray<string>;
};

/** The single name a source declares, when its kind names one. */
export const declaredNameOf = (source: EnvSource): string | undefined =>
  "name" in source ? source.name : undefined;

// ── names Junto keeps for itself ───────────────────────────────────────────

const TERMINAL_NAMES: ReadonlySet<string> = new Set([
  "TERM",
  "COLORTERM",
  "COLORFGBG",
]);

/**
 * Why a region may not set this name, or undefined when it may.
 * `PATH` is not reserved: a region's `PATH` is honored, with Junto's own CLI
 * directory kept in front of it.
 */
export const reservedEnvNameReason = (name: string): string | undefined => {
  // The whole prefix, not only the names Junto sets today: a region must not
  // be able to point a seat's own `junto` CLI somewhere else.
  if (name.startsWith("JUNTO_")) {
    return `${name} is not applied: names that start with JUNTO_ are reserved for Junto`;
  }
  if (TERMINAL_NAMES.has(name)) {
    return `Junto sets ${name} itself: every seat is a real terminal`;
  }
  if (
    (SPAWN_ENV_SCRUB as ReadonlyArray<string>).includes(name) ||
    SPAWN_ENV_SCRUB_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return `Junto removes ${name} from every seat: it marks a nested session`;
  }
  return undefined;
};

// ── plan ───────────────────────────────────────────────────────────────────

/**
 * What is resolved: a seat, or a region as if a seat sat directly inside it.
 * `rect` is where the seat sits right now when the caller knows better than
 * the document (canvas saves are debounced, so a seat that was just created
 * or moved may not be in the persisted document yet).
 */
export type RegionEnvironmentTarget =
  | { readonly seat: string; readonly rect?: RegionRect }
  | { readonly region: string };

export type PlannedRegion = {
  readonly regionId: string;
  readonly regionLabel: string;
  readonly sealed: boolean;
};

export type PlannedSource = {
  readonly regionId: string;
  readonly regionLabel: string;
  readonly source: EnvSource;
  /** `regionId` and source id: unique within a plan. */
  readonly key: string;
  /** True when the source names another machine and is not resolved here. */
  readonly skippedHost: boolean;
};

export type RegionEnvironmentPlan = {
  /** Regions in scope, outermost first. Regions cut off by a seal are absent. */
  readonly regions: ReadonlyArray<PlannedRegion>;
  /** Every source in scope, in application order. */
  readonly sources: ReadonlyArray<PlannedSource>;
  /** Extra directories in scope, outermost region first, as written. */
  readonly folders: ReadonlyArray<string>;
};

export const sourceKey = (regionId: string, sourceId: string): string =>
  `${regionId}\u0000${sourceId}`;

const EMPTY_PLAN: RegionEnvironmentPlan = { regions: [], sources: [], folders: [] };

/**
 * The ordered plan for one target on one machine. Pure and total: an unknown
 * node, or a seat inside no region, yields the empty plan.
 */
export const planRegionEnvironment = (
  doc: CanvasDoc,
  target: RegionEnvironmentTarget,
  hostId: string,
): RegionEnvironmentPlan => {
  let stack: ReadonlyArray<GroupNode>;
  if ("seat" in target) {
    stack = (
      target.rect ? regionStack(doc, target.rect) : regionStack(doc, target.seat)
    ).filter((region) => region.id !== target.seat);
  } else {
    const region = doc.nodes.find((node) => node.id === target.region);
    if (!region || !isGroup(region)) return EMPTY_PLAN;
    stack = [...regionStack(doc, region.id), region];
  }
  // A sealed region cuts everything outside it. The innermost seal wins.
  let from = 0;
  stack.forEach((region, index) => {
    if (region.ether?.region?.environment?.sealed === true) from = index;
  });
  const scope = stack.slice(from);
  const regions: PlannedRegion[] = [];
  const sources: PlannedSource[] = [];
  const folders: string[] = [];
  for (const region of scope) {
    const environment = region.ether?.region?.environment;
    const regionLabel = regionDisplayName(region);
    regions.push({
      regionId: region.id,
      regionLabel,
      sealed: environment?.sealed === true,
    });
    for (const source of environment?.sources ?? []) {
      sources.push({
        regionId: region.id,
        regionLabel,
        source,
        key: sourceKey(region.id, source.id),
        // `local` in a document means the machine reading it.
        skippedHost:
          source.host !== undefined &&
          source.host !== hostId &&
          source.host !== DEFAULT_STATION_HOST_ID,
      });
    }
    for (const folder of environment?.folders ?? []) {
      const trimmed = folder.trim();
      if (trimmed.length > 0 && !folders.includes(trimmed)) folders.push(trimmed);
    }
  }
  return { regions, sources, folders };
};

// ── merge ──────────────────────────────────────────────────────────────────

export type RegionEnvironmentMerge = {
  /** Names to values, for the spawn only. */
  readonly env: Readonly<Record<string, string>>;
  /** One entry per source in scope, in application order. */
  readonly report: ReadonlyArray<SourceReport>;
  /** Which source each name in `env` came from, as a `sourceKey`. */
  readonly providers: Readonly<Record<string, string>>;
  /** Set when a `required` source could not be read: the launch is refused. */
  readonly refusal?: string;
};

const sentence = (text: string): string =>
  text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;

/**
 * Merge what each source resolved to, in plan order, into the seat's
 * environment and its report. `outcomes` is keyed by `PlannedSource.key`; a
 * source with no outcome is reported as an error, never treated as absent.
 */
export const mergeRegionEnvironment = (
  plan: RegionEnvironmentPlan,
  outcomes: ReadonlyMap<string, SourceResolution>,
  staticNamesOf: (source: EnvSource) => ReadonlyArray<string> = (source) => {
    const name = declaredNameOf(source);
    return name === undefined ? [] : [name];
  },
): RegionEnvironmentMerge => {
  const env: Record<string, string> = {};
  const providers: Record<string, string> = {};
  type Draft = {
    readonly planned: PlannedSource;
    readonly names: ReadonlyArray<string>;
    readonly status: SourceReportStatus;
    readonly reason?: string;
  };
  const drafts: Draft[] = [];
  const refusals: string[] = [];

  for (const planned of plan.sources) {
    const { source } = planned;
    if (planned.skippedHost) {
      drafts.push({
        planned,
        names: staticNamesOf(source),
        status: "skipped-host",
        reason: `Only on ${source.host}`,
      });
      continue;
    }
    const outcome: SourceResolution = outcomes.get(planned.key) ?? {
      status: "error",
      names: staticNamesOf(source),
      reason: "This source was not resolved",
    };
    if (outcome.status !== "ok") {
      drafts.push({
        planned,
        names: outcome.names,
        status: outcome.status,
        reason: outcome.reason,
      });
      if (source.required === true) {
        refusals.push(
          `${planned.regionLabel}: ${outcome.names.length > 0 ? `${outcome.names.join(", ")} ` : ""}is required and could not be read. ${sentence(outcome.reason)}`,
        );
      }
      continue;
    }
    const kept: string[] = [];
    const reserved: string[] = [];
    for (const [name, value] of Object.entries(outcome.values)) {
      const why = reservedEnvNameReason(name);
      if (why !== undefined) {
        reserved.push(why);
        continue;
      }
      env[name] = value;
      providers[name] = planned.key;
      kept.push(name);
    }
    if (kept.length === 0 && reserved.length > 0) {
      // Every name this source offers is one Junto keeps for itself.
      drafts.push({
        planned,
        names: Object.keys(outcome.values),
        status: "overridden",
        reason: reserved.join(". "),
      });
      continue;
    }
    drafts.push({
      planned,
      names: kept,
      status: "ok",
      ...(reserved.length > 0 ? { reason: `Left out: ${reserved.join(". ")}` } : {}),
    });
  }

  const report = drafts.map((draft): SourceReport => {
    const { planned } = draft;
    // A source that lost every name to a later one is overridden. One that
    // lost only some stays ok: per name, the last ok provider wins.
    const lostAll =
      draft.status === "ok" &&
      draft.names.length > 0 &&
      draft.names.every((name) => providers[name] !== planned.key);
    return {
      regionId: planned.regionId,
      regionLabel: planned.regionLabel,
      sourceId: planned.source.id,
      kind: planned.source.kind,
      names: [...draft.names],
      status: lostAll ? "overridden" : draft.status,
      ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
      required: planned.source.required === true,
    };
  });

  return {
    env,
    report,
    providers,
    ...(refusals.length > 0 ? { refusal: refusals.join(" ") } : {}),
  };
};

// ── what a running seat was launched with ──────────────────────────────────

/** FNV-1a 64 as hex. No secrets are hashed here, so no keyed hash is needed. */
const fnv1a64 = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** One source as the document writes it, in its region: the provider's identity. */
export const sourceSignature = (planned: PlannedSource): string =>
  fnv1a64(canonical([planned.regionId, planned.source]));

/**
 * The plan's identity: which sources are in scope, in which order, written
 * how, and which folders. It is computed from the document alone, so telling
 * whether a running seat is current never reads a store. A value changed
 * behind an unchanged reference (a rotated Keychain item) does not move it.
 */
export const regionEnvironmentFingerprint = (
  plan: RegionEnvironmentPlan,
): string =>
  fnv1a64(
    canonical({
      sources: plan.sources.map((planned) => [
        sourceSignature(planned),
        planned.skippedHost,
      ]),
      folders: plan.folders,
    }),
  );

/**
 * What a generation was launched with: names and identities, never values.
 * `names` maps each variable to the signature of the source that provided it.
 */
export type RegionEnvironmentLaunchRecord = {
  readonly fingerprint: string;
  readonly names: Readonly<Record<string, string>>;
  readonly folders: ReadonlyArray<string>;
};

export const launchRecordOf = (
  plan: RegionEnvironmentPlan,
  merge: Pick<RegionEnvironmentMerge, "providers">,
): RegionEnvironmentLaunchRecord => {
  const signatures = new Map(
    plan.sources.map((planned) => [planned.key, sourceSignature(planned)]),
  );
  return {
    fingerprint: regionEnvironmentFingerprint(plan),
    names: Object.fromEntries(
      Object.entries(merge.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, key]) => [name, signatures.get(key) ?? ""]),
    ),
    folders: [...plan.folders],
  };
};

/** The record of a seat launched inside no region with an environment. */
export const EMPTY_LAUNCH_RECORD: RegionEnvironmentLaunchRecord = launchRecordOf(
  EMPTY_PLAN,
  { providers: {} },
);

/**
 * Variable names that would differ after a restart: added, removed, or now
 * provided by a different source. `current` is the record the seat would be
 * launched with now.
 */
export const changedNames = (
  launched: RegionEnvironmentLaunchRecord,
  current: RegionEnvironmentLaunchRecord,
): ReadonlyArray<string> => {
  const names = new Set([
    ...Object.keys(launched.names),
    ...Object.keys(current.names),
  ]);
  return [...names]
    .filter((name) => launched.names[name] !== current.names[name])
    .sort((a, b) => a.localeCompare(b));
};
