/**
 * Semantic verbs — the single authored fact on an edge.
 *
 * An edge says one thing: *what this relationship is*. `verb` is the only word
 * the operator writes; ports and task-path flow are **compiled**
 * from the verb plus the two endpoint kinds. There is no second authoring
 * surface and no mirror to keep in sync.
 *
 * - `VERB_TABLE` — which verbs an ordered kind pair admits (hand-written, one
 *   row per row of the grammar). Anything absent from the table is refused at
 *   connect.
 * - `compileVerb` — verb + pair → the flat grant the kernel reads.
 */
import { Schema } from "effect";
import {
  isWellKnownKind,
  type ActorKind,
  type Port,
  type SinkKind,
} from "./schema";

// ---------------------------------------------------------------------------
// The verbs

export const Verb = Schema.Literals([
  "messages",
  "navigates",
  "flows",
  "derives",
]);
export type Verb = typeof Verb.Type;

export const VERBS: ReadonlyArray<Verb> = Verb.literals;

// ---------------------------------------------------------------------------
// Table sides

export type VerbSide = ActorKind | SinkKind;

/**
 * Kind → table side. Unknown or geography kinds have no side, which is what
 * makes them unwireable: no side, no row, no verb.
 */
export const verbSideOf = (kind: string | undefined): VerbSide | undefined =>
  kind !== undefined && isWellKnownKind(kind) ? kind : undefined;

type VerbTable = {
  readonly [S in VerbSide]?: {
    readonly [T in VerbSide]?: ReadonlyArray<Verb>;
  };
};

/**
 * Ordered source → target rows. The order is semantic: the row's source is the
 * verb's subject, whatever way the operator happened to drag.
 *
 * Two verbs per ordered pair is the ceiling (tested). Where a pair holds two,
 * a plain connect stamps the first. No verb grants access to a resource node:
 * a seat reaches those by region (01).
 */
export const VERB_TABLE = {
  agent: {
    agent: ["messages"],
    page: ["navigates"],
  },
  task: {
    task: ["flows", "derives"],
  },
  // Terminal publishes nothing and offers no port: no verb speaks to it yet.
  terminal: {},
  // Automations take no edge: they act by reach (07).
  automations: {},
  // Files take no edge, like git: seats have the filesystem.
  files: {},
} as const satisfies VerbTable;

const NO_VERBS: ReadonlyArray<Verb> = [];

/**
 * The verbs that join two task boards. Each keeps its own graph a DAG, and a
 * pair of boards holds one of them at most: a task either moves on or makes
 * a new task there, never both.
 */
export const TASK_PATH_VERBS = ["flows", "derives"] as const satisfies ReadonlyArray<Verb>;
export type TaskPathVerb = (typeof TASK_PATH_VERBS)[number];
export const isTaskPathVerb = (verb: Verb | undefined): verb is TaskPathVerb =>
  verb === "flows" || verb === "derives";

/** Verbs legal for this ordered pair. Empty = connect refused. */
export const verbsForPair = (
  source: string | undefined,
  target: string | undefined,
): ReadonlyArray<Verb> => {
  const from = verbSideOf(source);
  const to = verbSideOf(target);
  if (from === undefined || to === undefined) return NO_VERBS;
  const table: VerbTable = VERB_TABLE;
  return table[from]?.[to] ?? NO_VERBS;
};

/** What a plain connect stamps: the pair's first verb. */
export const defaultVerbForPair = (
  source: string | undefined,
  target: string | undefined,
): Verb | undefined => verbsForPair(source, target)[0];

// ---------------------------------------------------------------------------
// Compilation

/**
 * The flat facts a verb grants. Every field is derived — nothing here is ever
 * read from, or written back to, the document.
 */
export type VerbGrant = {
  /** Ports this relationship opens. Empty for non-access verbs. */
  readonly ports: ReadonlyArray<Port>;
  /** Task path hop between Tasks nodes (DAG-guarded). */
  readonly flow?: boolean;
  /** Finishing a task on the source board makes a new one on the target (DAG-guarded). */
  readonly derive?: boolean;
};

const MSG_PORTS = [
  "msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read",
] as const satisfies ReadonlyArray<Port>;

const NO_PORTS: ReadonlyArray<Port> = [];

/**
 * Verb + ordered pair → grant. `undefined` when the verb is not legal for the
 * pair, so a stale or hand-edited verb grants nothing rather than something
 * adjacent.
 */
export const compileVerb = (
  verb: Verb,
  source: string | undefined,
  target: string | undefined,
): VerbGrant | undefined => {
  if (!verbsForPair(source, target).includes(verb)) return undefined;
  switch (verb) {
    case "messages":
      return { ports: MSG_PORTS };
    case "navigates":
      return { ports: ["browser.automate"] };
    case "flows":
      return { ports: NO_PORTS, flow: true };
    case "derives":
      return { ports: NO_PORTS, derive: true };
    default: {
      const exhaustive: never = verb;
      return exhaustive;
    }
  }
};

// ---------------------------------------------------------------------------
// Paint

/**
 * CSS custom-property names per verb. Hues live in the stylesheet — this maps
 * the verb to its token and holds no color.
 */
export const VERB_COLOR_TOKEN: Record<Verb, string> = {
  messages: "--wire-verb-messages",
  navigates: "--wire-verb-navigates",
  flows: "--wire-verb-flows",
  derives: "--wire-verb-derives",
};
