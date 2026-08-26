/**
 * Node contracts — what a kind publishes to the rest of the factory.
 *
 * ports  → the capability facets an access verb may open
 * events → the news a relay may hear (`announces` compiles the default one)
 * inputs → the fire actions a scheduler verb may land here
 *
 * A verb never reads this table to decide what it grants — `physics/verbs.ts`
 * compiles that. Contracts are the published surface a new kind declares so the
 * grammar can reach it at all, plus the operator-facing explainer copy.
 */
import { Schema } from "effect";
import { isWellKnownKind, type Port, type WellKnownKind } from "./schema";
import { KindSpecs } from "./kinds";

/** A named event a sink/scheduler/actor announces for watch subscription. */
export const ContractEvent = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** Lexicon word this event carries on a watch wire. */
  word: Schema.Literals(["completes", "flagged"]),
  /** Optional flag when word is flagged. */
  flag: Schema.optionalKey(
    Schema.Literals(["blocker", "attention", "parked"]),
  ),
  /**
   * Discriminator for completes variants on one wire (OR multi-select).
   * Maps onto WatchWhenCompletes.equals — e.g. page ready vs failed.
   */
  equals: Schema.optionalKey(Schema.String),
});
export type ContractEvent = typeof ContractEvent.Type;

/** An input a target accepts from a scheduler's fire verb. */
export const ContractInput = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** Maps to EdgeEffect.mode — the three actions a scheduler verb compiles to. */
  mode: Schema.Literals(["enqueue_task", "set_flag", "inject_prompt"]),
});
export type ContractInput = typeof ContractInput.Type;

export type NodeContract = {
  readonly kind: WellKnownKind;
  readonly ports: ReadonlyArray<Port>;
  readonly events: ReadonlyArray<ContractEvent>;
  readonly inputs: ReadonlyArray<ContractInput>;
};

const flagEvents: ReadonlyArray<ContractEvent> = [
  {
    id: "flag.attention",
    label: "Marked needs attention",
    word: "flagged",
    flag: "attention",
  },
  {
    id: "flag.blocker",
    label: "Marked blocker",
    word: "flagged",
    flag: "blocker",
  },
  {
    id: "flag.parked",
    label: "Marked parked",
    word: "flagged",
    flag: "parked",
  },
];

const enqueueInput: ContractInput = {
  id: "input.enqueue_task",
  label: "Add a task",
  mode: "enqueue_task",
};

const flagInput: ContractInput = {
  id: "input.set_flag",
  label: "Set a flag",
  mode: "set_flag",
};

const injectPromptInput: ContractInput = {
  id: "input.inject_prompt",
  label: "Inject a prompt",
  mode: "inject_prompt",
};

const portsOf = (kind: WellKnownKind): ReadonlyArray<Port> => [
  ...KindSpecs[kind].offers,
];

/**
 * Exhaustive contracts for well-known kinds.
 * Events/inputs are product-facing; ports stay kind-table truth.
 */
export const NodeContracts: {
  readonly [K in WellKnownKind]: NodeContract;
} = {
  agent: {
    kind: "agent",
    ports: portsOf("agent"),
    // Watch is sink→relay; agent is not a watch source. Flags only for effect/access.
    events: [...flagEvents],
    inputs: [injectPromptInput, flagInput],
  },
  task: {
    kind: "task",
    ports: portsOf("task"),
    events: [
      {
        id: "task.completes",
        label: "A task completes",
        word: "completes",
        equals: "completed",
      },
      ...flagEvents,
    ],
    inputs: [enqueueInput, flagInput],
  },
  requests: {
    kind: "requests",
    ports: portsOf("requests"),
    events: [
      {
        id: "request.answered",
        label: "A request is answered",
        word: "completes",
        equals: "completed",
      },
      ...flagEvents,
    ],
    inputs: [flagInput],
  },
  artifacts: {
    kind: "artifacts",
    ports: portsOf("artifacts"),
    events: [
      {
        id: "artifact.published",
        label: "An artifact is published",
        word: "completes",
        equals: "published",
      },
    ],
    inputs: [flagInput],
  },
  board: {
    kind: "board",
    ports: portsOf("board"),
    events: [
      {
        id: "board.post",
        label: "A post lands",
        word: "completes",
        equals: "post",
      },
      {
        id: "board.topic",
        label: "A topic is created",
        word: "completes",
        equals: "topic",
      },
    ],
    // A scheduler reaches a board with `flags` and nothing else: posting is an
    // agent's port, never a fire action.
    inputs: [flagInput],
  },
  pad: {
    kind: "pad",
    ports: portsOf("pad"),
    events: [...flagEvents],
    inputs: [flagInput],
  },
  page: {
    kind: "page",
    ports: portsOf("page"),
    // Pages have no product attention/blocker state — only session outcomes.
    events: [
      {
        id: "page.ready",
        label: "Page ready",
        word: "completes",
        equals: "ready",
      },
      {
        id: "page.failed",
        label: "Page failed",
        word: "completes",
        equals: "failed",
      },
    ],
    inputs: [flagInput],
  },
  terminal: {
    kind: "terminal",
    ports: portsOf("terminal"),
    events: [],
    inputs: [flagInput],
  },
  cron: {
    kind: "cron",
    ports: portsOf("cron"),
    events: [
      {
        id: "cron.fired",
        label: "Fired",
        word: "completes",
      },
    ],
    inputs: [],
  },
  timer: {
    kind: "timer",
    ports: portsOf("timer"),
    events: [
      {
        id: "timer.fired",
        label: "Fired",
        word: "completes",
      },
    ],
    inputs: [],
  },
  watcher: {
    kind: "watcher",
    ports: portsOf("watcher"),
    events: [
      {
        id: "watcher.fired",
        label: "Fired",
        word: "completes",
      },
    ],
    inputs: [],
  },
  relay: {
    kind: "relay",
    ports: portsOf("relay"),
    events: [
      {
        id: "relay.fired",
        label: "Fired",
        word: "completes",
      },
    ],
    inputs: [],
  },
};

export const contractOf = (
  kind: string | undefined,
): NodeContract | undefined => {
  if (kind === undefined || !isWellKnownKind(kind)) return undefined;
  return NodeContracts[kind];
};

// ---------------------------------------------------------------------------
// Catalog explainer
//
// The node catalog tells the operator what a kind can be wired for before any
// edge exists, so it reads the three published surfaces above rather than a
// verb (there is no pair yet to compile one against). `WireFamily` is that
// explainer's grouping label and nothing more — it is not a document field, not
// a connect rule, and no verb consults it.

/** Which published surface a catalog explainer line came from. */
export type WireFamily = "access" | "watch" | "effect";

/**
 * Fixed hue token per explainer line. Renderers map the token to a theme hue.
 *
 * The return type still names `violet`, which no live family reaches: the node
 * catalog's hue record enumerates it, and TypeScript reads a missing member as
 * an excess key there. It goes when that record is cut over.
 */
export const familyColorToken = (
  family: WireFamily,
): "steel" | "cyan" | "violet" | "amber" => {
  switch (family) {
    case "access":
      return "steel";
    case "watch":
      return "cyan";
    case "effect":
      return "amber";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
};
