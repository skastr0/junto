/**
 * Node contracts — published surfaces every wire family operates against.
 *
 * ports  → access attenuates
 * events → watch subscribes (OR within a wire)
 * inputs → effect delivers into
 * state  → display-only (flags, agent state); never authorable on wires
 *
 * New kinds extend the system by publishing a contract; connect, sheet, and
 * grammar stay fixed. See wire-grammar artifact sheet law.
 */
import { Schema } from "effect";
import { isWellKnownKind, type Port, type WellKnownKind } from "./schema";
import { KindSpecs } from "./kinds";
import type { WireFamily, WireWord } from "./wires";

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
});
export type ContractEvent = typeof ContractEvent.Type;

/** An input a target accepts from an effect wire. */
export const ContractInput = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** Maps to EdgeEffect.mode. */
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
    events: [
      {
        id: "agent.finishes",
        label: "Finishes work",
        word: "completes",
      },
      ...flagEvents,
    ],
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
      },
      ...flagEvents,
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
      },
      {
        id: "board.topic",
        label: "A topic is created",
        word: "completes",
      },
      ...flagEvents,
    ],
    inputs: [flagInput],
  },
  page: {
    kind: "page",
    ports: portsOf("page"),
    events: [
      {
        id: "page.ready",
        label: "Page ready",
        word: "completes",
      },
      {
        id: "page.failed",
        label: "Page failed",
        word: "completes",
      },
      ...flagEvents,
    ],
    inputs: [flagInput],
  },
  terminal: {
    kind: "terminal",
    ports: portsOf("terminal"),
    events: [...flagEvents],
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

/** Sheet sections the edge form may render — family + kinds decide, never a hand list. */
export type SheetSection =
  | { readonly _tag: "ports" }
  | { readonly _tag: "wake" }
  | {
      readonly _tag: "when";
      readonly events: ReadonlyArray<ContractEvent>;
    }
  | {
      readonly _tag: "does";
      readonly inputs: ReadonlyArray<ContractInput>;
    }
  | { readonly _tag: "trigger_readout" }
  /** Deliberate gate: proof or human approval only. */
  | { readonly _tag: "hold" }
  | { readonly _tag: "delete" };

/**
 * Sheet law: a setting exists only where physics cannot derive the answer.
 * Sections come from family; options come from the kind contracts.
 *
 * - access → ports (+ wake when board is either end)
 * - watch  → when events from the source sink's contract
 * - effect → does inputs from the target's contract
 * - trigger → readout only (no settings)
 * Always ends with delete.
 */
export const sheetSectionsFor = (input: {
  readonly family: WireFamily;
  readonly fromKind?: string;
  readonly toKind?: string;
}): ReadonlyArray<SheetSection> => {
  const { family, fromKind, toKind } = input;
  const sections: SheetSection[] = [];
  if (family === "access") {
    sections.push({ _tag: "ports" });
    if (fromKind === "board" || toKind === "board") {
      sections.push({ _tag: "wake" });
    }
    sections.push({ _tag: "hold" });
  } else if (family === "watch") {
    // Watch observes the source (sink → relay). Events from source contract.
    const source = contractOf(fromKind);
    const events = source?.events ?? [];
    sections.push({ _tag: "when", events });
  } else if (family === "effect") {
    // Effect lands on the target. Inputs from target contract.
    const target = contractOf(toKind);
    const inputs = target?.inputs ?? [flagInput];
    sections.push({ _tag: "does", inputs });
  } else if (family === "trigger") {
    sections.push({ _tag: "trigger_readout" });
  }
  sections.push({ _tag: "delete" });
  return sections;
};

/** Title for the edge sheet from family. */
export const sheetTitleFor = (family: WireFamily): string => {
  switch (family) {
    case "access":
      return "Access";
    case "watch":
      return "Watch";
    case "trigger":
      return "Trigger";
    case "effect":
      return "On fire";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
};

/** Which lexicon word a sheet section authors (for sentence preview). */
export const wordForSheetSection = (
  section: SheetSection,
): WireWord | undefined => {
  switch (section._tag) {
    case "wake":
      return "wakes";
    case "when":
      return section.events[0]?.word;
    case "does":
      return section.inputs.some((i) => i.mode === "enqueue_task")
        ? "enqueues"
        : "flags";
    default:
      return undefined;
  }
};
