import { Data, HashMap, HashSet, Match } from "effect";
import {
  isWellKnownKind,
  portSet,
  type FactoryRole,
  type Port,
  type WellKnownKind,
} from "./schema";

// Kind → role + offered ports. Exhaustive over WellKnownKind.
// Roles are derived here — never read from authorial ether.role.

export type KindSpec = {
  readonly kind: WellKnownKind;
  readonly role: FactoryRole;
  readonly offers: HashSet.HashSet<Port>;
};

const emptyOffers: HashSet.HashSet<Port> = HashSet.empty();

const msgOffers = portSet("msg.list", "msg.send");
const taskOffers = portSet(
  "tasks.list",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
);
const requestsOffers = portSet("request.create", "msg.list", "msg.send");
const artifactsOffers = portSet("artifact.publish");
const pageOffers = portSet("browser.automate");

/**
 * Exhaustive well-known kind table. Adding a WellKnownKind without a row is a
 * type error (`satisfies Record<WellKnownKind, KindSpec>`).
 */
export const KindSpecs = {
  agent: { kind: "agent", role: "actor", offers: msgOffers },
  terminal: { kind: "terminal", role: "actor", offers: emptyOffers },
  herdr: { kind: "herdr", role: "actor", offers: msgOffers },
  page: { kind: "page", role: "sink", offers: pageOffers },
  task: { kind: "task", role: "sink", offers: taskOffers },
  requests: { kind: "requests", role: "sink", offers: requestsOffers },
  artifacts: { kind: "artifacts", role: "sink", offers: artifactsOffers },
  watcher: { kind: "watcher", role: "scheduler", offers: emptyOffers },
  timer: { kind: "timer", role: "scheduler", offers: emptyOffers },
} as const satisfies Record<WellKnownKind, KindSpec>;

export const KindRegistry: HashMap.HashMap<WellKnownKind, KindSpec> =
  HashMap.fromIterable(
    (Object.keys(KindSpecs) as WellKnownKind[]).map((kind) => [
      kind,
      KindSpecs[kind],
    ]),
  );

/** Resolved kind identity for Match.tagsExhaustive (roleOf, admit). */
export type ResolvedSpec = Data.TaggedEnum<{
  Known: {
    readonly kind: WellKnownKind;
    readonly role: FactoryRole;
    readonly offers: HashSet.HashSet<Port>;
  };
  Geography: {
    readonly role: "geography";
    readonly kind: string | undefined;
    readonly offers: HashSet.HashSet<Port>;
  };
}>;

export const ResolvedSpec = Data.taggedEnum<ResolvedSpec>();

export type ResolveSpecInput = {
  readonly isGroup: boolean;
  readonly kind: string | undefined;
};

/**
 * Derive a resolved physics spec from canvas node shape.
 * Well-known kinds → KindSpecs; groups and everything else → geography.
 */
export const resolveSpec = (input: ResolveSpecInput): ResolvedSpec => {
  if (!input.isGroup && input.kind !== undefined && isWellKnownKind(input.kind)) {
    const spec = KindSpecs[input.kind];
    return ResolvedSpec.Known({
      kind: spec.kind,
      role: spec.role,
      offers: spec.offers,
    });
  }
  return ResolvedSpec.Geography({
    role: "geography",
    kind: input.kind,
    offers: emptyOffers,
  });
};

export const roleOf = (spec: ResolvedSpec): FactoryRole =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Known: (s) => s.role,
      Geography: (s) => s.role,
    }),
  );

export const offersOf = (spec: ResolvedSpec): HashSet.HashSet<Port> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Known: (s) => s.offers,
      Geography: (s) => s.offers,
    }),
  );

export const lookupKindSpec = (
  kind: WellKnownKind,
): KindSpec => KindSpecs[kind];
