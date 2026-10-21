/**
 * Semantic verbs — the single authored fact on an edge.
 *
 * An edge says one thing: *what this relationship is*. `verb` is the only word
 * the operator writes; ports, board wake and task-path flow are **compiled**
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
  "reviews",
  "participates",
  "navigates",
  "feeds",
]);
export type Verb = typeof Verb.Type;

export const VERBS: ReadonlyArray<Verb> = Verb.literals;

// ---------------------------------------------------------------------------
// Table sides

export type VerbSide = ActorKind | SinkKind;

/**
 * Kind → table side. Unknown, geography or scheduler kinds have no side, which
 * is what makes them unwireable: no side, no row, no verb.
 */
export const verbSideOf = (kind: string | undefined): VerbSide | undefined => {
  if (kind === undefined || !isWellKnownKind(kind)) return undefined;
  switch (kind) {
    case "relay":
    case "cron":
    case "timer":
    case "watcher":
      return undefined;
    default:
      return kind;
  }
};

type VerbTable = {
  readonly [S in VerbSide]?: {
    readonly [T in VerbSide]?: ReadonlyArray<Verb>;
  };
};

/**
 * Ordered source → target rows. The order is semantic: the row's source is the
 * verb's subject, whatever way the operator happened to drag.
 *
 * Two verbs per ordered pair is the ceiling (tested). Row order never decides
 * the default — `DEFAULT_CONNECT_VERBS` does. No verb grants access to a
 * resource node: a seat reaches those by region (01).
 */
export const VERB_TABLE = {
  agent: {
    agent: ["messages", "reviews"],
    board: ["messages", "participates"],
    page: ["navigates"],
  },
  task: {
    task: ["feeds"],
  },
  // Terminal publishes nothing and offers no port: no verb speaks to it yet.
  terminal: {},
  // Automations take no edge: they act by reach (07).
  automations: {},
} as const satisfies VerbTable;

const NO_VERBS: ReadonlyArray<Verb> = [];

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

/**
 * What a plain connect stamps where a pair holds two verbs: the fuller
 * relationship — participate, not just read the board — because the narrow
 * one is the deliberate choice, not the accident.
 */
const DEFAULT_CONNECT_VERBS: ReadonlyArray<Verb> = ["participates"];

export const defaultVerbForPair = (
  source: string | undefined,
  target: string | undefined,
): Verb | undefined => {
  const verbs = verbsForPair(source, target);
  if (verbs.length <= 1) return verbs[0];
  return verbs.find((verb) => DEFAULT_CONNECT_VERBS.includes(verb)) ?? verbs[0];
};

// ---------------------------------------------------------------------------
// Compilation

/**
 * The flat facts a verb grants. Every field is derived — nothing here is ever
 * read from, or written back to, the document.
 */
export type VerbGrant = {
  /** Ports this relationship opens. Empty for non-access verbs. */
  readonly ports: ReadonlyArray<Port>;
  /** Board megaphone reaches this seat. */
  readonly wake?: boolean;
  /** Task path hop between Tasks nodes (DAG-guarded). */
  readonly flow?: boolean;
};

const MSG_PORTS = [
  "msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read",
] as const satisfies ReadonlyArray<Port>;

const BOARD_MESSAGE_PORTS = [
  "board.list",
  "board.post",
  "board.mark_read",
] as const satisfies ReadonlyArray<Port>;

const BOARD_PARTICIPATE_PORTS = [
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
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
      return target === "board"
        ? { ports: BOARD_MESSAGE_PORTS, wake: false }
        : { ports: MSG_PORTS };
    case "reviews":
      return { ports: ["verdict.post"] };
    case "participates":
      return { ports: BOARD_PARTICIPATE_PORTS, wake: true };
    case "navigates":
      return { ports: ["browser.automate"] };
    case "feeds":
      return { ports: NO_PORTS, flow: true };
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
  reviews: "--wire-verb-reviews",
  participates: "--wire-verb-participates",
  navigates: "--wire-verb-navigates",
  feeds: "--wire-verb-feeds",
};
