// `junto automation` in main (plan 07, cli L4): decode each verb, find the
// Automations node and the automation, resolve every target against
// `automationTargets`, and hand each write to the ruler as a ResourceCommand
// (02). Seats read on the work socket; only the operator and overseers write,
// through the overseer plane, and the domain refuses any other seat. The
// store, the ruler and the runner reach this file through `AutomationPorts`;
// `liveAutomationPorts` is the app's, over automation/apply.ts.

import { type Context, Effect, Option, Result, Schema } from "effect";
import { MachineRepository } from "../machines/repository";
import { nearestOf } from "./authz";
import {
  FIRINGS_PAGE_MAX,
  FiringId,
  type Automation,
  type AutomationAuthor,
  type AutomationId,
  type AutomationOp,
  type Firing,
} from "@shared/automation";
import {
  AutomationCreateArgs,
  AutomationEditArgs,
  AutomationHistoryArgs,
  AutomationListArgs,
  AutomationMoveArgs,
  AutomationOneArgs,
  AutomationShowArgs,
  editedDefinition,
  reservedTriggerRefusal,
  resolveTargets,
  staleRefusal,
  type AutomationReadOp,
  type AutomationWriteOp,
  type AutomationWriteResult,
  type TriggerInput,
} from "@shared/automation-control";
import { parseMentionHref } from "@shared/mention";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { reaches } from "@shared/region-reach";
import type { ResourceActor, ResourceCommand } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import { isItemId, type ItemId, type OpId } from "@shared/work-ids";
import { type AutomationApplyServices, applyAutomationCommand, offEditorRefusal } from "../automation/apply";
import { AutomationRepository } from "../automation/repository";
import { automationTargetResolver } from "./automation-targets";

export type HistoryQuery = {
  readonly automationId?: ItemId;
  readonly limit: number;
  readonly before?: string;
};

/** What the verbs need from the automation store and the ruler. */
export type AutomationPorts = {
  /** The canvas's Automations nodes. */
  readonly nodes: (canvas: Canvas) => ReadonlyArray<Node>;
  readonly automations: (canvasName: string, nodeId: NodeId) => Effect.Effect<ReadonlyArray<Automation>, WorkErrorBody>;
  /** Newest first. */
  readonly firings: (canvasName: string, nodeId: NodeId, query: HistoryQuery) => Effect.Effect<ReadonlyArray<Firing>, WorkErrorBody>;
  readonly submit: (command: ResourceCommand<AutomationOp>) => Effect.Effect<AutomationWriteResult, WorkErrorBody>;
  /**
   * The machines an automation may name (0.11, 05, S1): this one and the
   * peers it knows, by short name. Absent, or undefined in a build without
   * the machine store, any well-formed name is taken.
   */
  readonly machines?: () => Effect.Effect<ReadonlyArray<string> | undefined, WorkErrorBody>;
};

/** A seat reading the Automations nodes in its reach. */
export type AutomationCaller = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" }>;
};

/** The operator, or an overseer seat writing with the operator's authority. */
export type AutomationWriter = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" | "operator" }>;
};

const HISTORY_DEFAULT_LIMIT = 50;

const notBuilt = (what: string): WorkErrorBody => ({
  type: "InputError",
  message: `${what} is not built in this Junto build yet`,
  details: { reason: "not_available", retryable: false },
});

const persistence = (error: unknown): WorkErrorBody => ({
  type: "RuntimeDown",
  message: `the automation store failed: ${String((error as { readonly message?: unknown } | undefined)?.message ?? error)}`,
  details: { retryable: true },
});

/**
 * Run a store or ruler effect in the app's own services. A build without the
 * automation store (a bare socket in a test) refuses as not built.
 */
const inApp = <A>(what: string, effect: Effect.Effect<A, unknown, AutomationApplyServices>): Effect.Effect<A, WorkErrorBody> =>
  Effect.gen(function* () {
    if (Option.isNone(yield* Effect.serviceOption(AutomationRepository))) return yield* Effect.fail(notBuilt(what));
    const services = (yield* Effect.context<never>()) as Context.Context<AutomationApplyServices>;
    return yield* effect.pipe(Effect.provideContext(services), Effect.mapError(persistence));
  });

/**
 * A copy's store is empty, since nothing fills it, so a read off the editing
 * machine refuses and names that machine rather than answering nothing.
 */
const onEditor = (canvasName: string): Effect.Effect<void, WorkErrorBody> =>
  Effect.flatMap(inApp("the automation store", offEditorRefusal(canvasName, "kept")), Option.match({
    onNone: () => Effect.void,
    onSome: (refusal) => Effect.fail(refusal),
  }));

/**
 * A machine a create or a move names must be one this machine knows: a typo
 * would be applied, and the automation would fire nowhere.
 */
const knownMachine = (ports: AutomationPorts, machine: string): Effect.Effect<void, WorkErrorBody> =>
  Effect.gen(function* () {
    const known = ports.machines === undefined ? undefined : yield* ports.machines();
    if (known === undefined || known.includes(machine)) return;
    const nearest = nearestOf(machine, known);
    return yield* Effect.fail<WorkErrorBody>({
      type: "UnknownTarget",
      message: `no machine ${machine} is known here`,
      details: {
        path: "machine",
        received: machine,
        retryable: false,
        ...(nearest.length === 0 ? {} : { nearest }),
        hint: `machines: ${known.join(", ")}`,
        next_step: "junto machine list names the machines this one knows",
      },
    });
  });

const newestFirst = (a: Firing, b: Firing) => (a.firingId < b.firingId ? 1 : a.firingId > b.firingId ? -1 : 0);

/**
 * The automation store and the one write path (automation/apply.ts): the
 * canvas's Automations nodes, their automations and firings, and every write
 * ruled on this machine when it edits the canvas.
 */
export const liveAutomationPorts: AutomationPorts = {
  nodes: (canvas) => [...canvas.nodes.values()].filter((node) => node.kind === "automations"),
  automations: (canvasName, nodeId) =>
    Effect.andThen(onEditor(canvasName), inApp("the automation store", Effect.gen(function* () {
      return yield* (yield* AutomationRepository).list(canvasName, nodeId);
    }))),
  firings: (canvasName, nodeId, query) =>
    Effect.gen(function* () {
      const before = query.before === undefined ? undefined : decodeFiringId(query.before);
      if (before !== undefined && Option.isNone(before)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: `${query.before} is not a firing id`,
          details: { path: "before", retryable: false },
        });
      }
      const page = { limit: Math.min(query.limit, FIRINGS_PAGE_MAX), ...(before === undefined ? {} : { before: before.value }) };
      yield* onEditor(canvasName);
      return yield* inApp("automation history", Effect.gen(function* () {
        const store = yield* AutomationRepository;
        // One automation's page, or every automation on the node merged newest first.
        const ids = query.automationId !== undefined
          ? [query.automationId as AutomationId]
          : (yield* store.list(canvasName, nodeId)).map((automation) => automation.automationId);
        const firings: Array<Firing> = [];
        for (const automationId of ids) firings.push(...(yield* store.firings(canvasName, { automationId, ...page })));
        return firings.sort(newestFirst).slice(0, page.limit);
      }));
    }),
  machines: () =>
    Effect.flatMap(Effect.serviceOption(MachineRepository), Option.match({
      // A build without the machine store checks nothing here; the ruler still takes only a well-formed name.
      onNone: () => Effect.succeed(undefined),
      onSome: (machines) =>
        Effect.map(Effect.all([machines.machineName, machines.peers]), ([self, peers]) => [self, ...peers.map((peer) => peer.machineName)]),
    })).pipe(Effect.mapError(persistence)),
  submit: (command) =>
    Effect.flatMap(inApp("the automation ruler", applyAutomationCommand(command)), (outcome) =>
      outcome.kind === "refused"
        ? Effect.fail(outcome.error)
        : Effect.succeed({
            disposition: "applied",
            opId: outcome.opId,
            automationId: outcome.automation.automationId,
            version: outcome.automation.version,
          } as const)),
};

const decodeFiringId = Schema.decodeUnknownOption(FiringId);

const decode = <S extends Schema.Top>(schema: S, args: unknown): Effect.Effect<S["Type"], WorkErrorBody> => {
  const decoded = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(args ?? {});
  return Result.isFailure(decoded)
    ? Effect.fail({
        type: "InputError",
        message: String((decoded.failure as { readonly message?: unknown }).message ?? decoded.failure),
        details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
      })
    : Effect.succeed(decoded.success as S["Type"]);
};

const namesOf = (names: ReadonlyArray<string>): string => names.slice(0, 12).join(", ");

/** The named Automations node; a seat reading it must also reach it. */
const findNode = (
  caller: { readonly canvas: Canvas },
  ports: AutomationPorts,
  text: string,
  reader?: NodeId,
): Effect.Effect<Node, WorkErrorBody> => {
  const nodes = ports.nodes(caller.canvas);
  const link = text.startsWith("junto://") ? parseMentionHref(text) : undefined;
  const named = link !== undefined
    ? nodes.filter((node) => node.id === link.nodeId && link.item === undefined)
    : nodes.filter((node) => node.id === text || titleOf(node) === text);
  if (named.length !== 1) {
    return Effect.fail({
      type: named.length === 0 ? "UnknownTarget" : "InputError",
      message: named.length === 0
        ? `no Automations node ${text} on this canvas`
        : `${named.length} Automations nodes are named ${text}; name one by its id`,
      details: {
        path: "target",
        received: text,
        retryable: false,
        hint: nodes.length === 0
          ? "this canvas has no Automations node"
          : `Automations nodes: ${namesOf(nodes.map(titleOf))}`,
      },
    });
  }
  const node = named[0]!;
  return reader === undefined || reaches(caller.canvas, reader, node.id)
    ? Effect.succeed(node)
    : Effect.fail({
        type: "ScopeError",
        message: `${titleOf(node)} is not in this seat's reach`,
        details: { path: "target", reason: "not_in_reach", retryable: false },
      });
};

const findAutomation = (
  views: ReadonlyArray<Automation>,
  text: string,
): Effect.Effect<Automation, WorkErrorBody> => {
  const named = isItemId(text)
    ? views.filter((view) => view.automationId === text)
    : views.filter((view) => view.name === text);
  return named.length === 1
    ? Effect.succeed(named[0]!)
    : Effect.fail({
        type: named.length === 0 ? "UnknownTarget" : "InputError",
        message: named.length === 0
          ? `no automation ${text} on this node`
          : `${named.length} automations are named ${text}; name one by its id`,
        details: {
          path: "automation",
          received: text,
          retryable: false,
          ...(views.length === 0 ? {} : { hint: `automations: ${namesOf(views.map((view) => view.name))}` }),
        },
      });
};

const command = (
  caller: AutomationWriter,
  opId: OpId,
  nodeId: NodeId,
  automationId: ItemId,
  op: AutomationOp,
): ResourceCommand<AutomationOp> => ({
  opId,
  canvasName: caller.canvasName,
  actor: caller.actor,
  target: { kind: "automation", nodeId, itemId: automationId },
  // Basis and the after chain come with remote's pending overlay (R2).
  basis: null,
  after: [],
  op,
});

const authorOf = (writer: AutomationWriter): AutomationAuthor =>
  writer.actor.kind === "seat" ? { kind: "seat", seat: writer.actor.nodeId } : { kind: "operator" };

const resolveIn = (writer: AutomationWriter, node: Node) =>
  automationTargetResolver(writer.canvas, node.id, authorOf(writer));

const resolved = <A>(out: { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: WorkErrorBody }) =>
  out.ok ? Effect.succeed(out.value) : Effect.fail(out.error);

/** Checked before any target resolves, so a webhook is refused as itself. */
const refuseReserved = (trigger: TriggerInput | undefined) => {
  if (trigger?.kind !== "webhook") return Effect.void;
  const refusal = reservedTriggerRefusal(trigger);
  return refusal === undefined ? Effect.void : Effect.fail(refusal);
};

/** One automation read, for a seat the work socket admitted. */
export const handleAutomationRead = (
  op: AutomationReadOp,
  args: unknown,
  caller: AutomationCaller,
  ports: AutomationPorts,
): Effect.Effect<unknown, WorkErrorBody> =>
  Effect.gen(function* () {
    switch (op) {
      case "automation.list": {
        const input = yield* decode(AutomationListArgs, args);
        const nodes = input.target === undefined
          ? ports.nodes(caller.canvas).filter((node) => reaches(caller.canvas, caller.actor.nodeId, node.id))
          : [yield* findNode(caller, ports, input.target, caller.actor.nodeId)];
        const automations: Array<Automation> = [];
        for (const node of nodes) automations.push(...(yield* ports.automations(caller.canvasName, node.id)));
        return { automations };
      }
      case "automation.show": {
        const input = yield* decode(AutomationShowArgs, args);
        const node = yield* findNode(caller, ports, input.target, caller.actor.nodeId);
        const automation = yield* findAutomation(yield* ports.automations(caller.canvasName, node.id), input.automation);
        return { automation };
      }
      case "automation.history": {
        const input = yield* decode(AutomationHistoryArgs, args);
        const node = yield* findNode(caller, ports, input.target, caller.actor.nodeId);
        const automationId = input.automation === undefined
          ? undefined
          : (yield* findAutomation(yield* ports.automations(caller.canvasName, node.id), input.automation)).automationId;
        const firings = yield* ports.firings(caller.canvasName, node.id, {
          limit: input.limit ?? HISTORY_DEFAULT_LIMIT,
          ...(automationId === undefined ? {} : { automationId }),
          ...(input.before === undefined ? {} : { before: input.before }),
        });
        return { firings };
      }
    }
  });

/**
 * One automation write, for the operator or an admitted overseer. The domain
 * rules it again: an overseer's targets must also be in its own reach.
 */
export const handleAutomationWrite = (
  op: AutomationWriteOp,
  args: unknown,
  writer: AutomationWriter,
  ports: AutomationPorts,
): Effect.Effect<AutomationWriteResult, WorkErrorBody> =>
  Effect.gen(function* () {
    switch (op) {
      case "automation.create": {
        const input = yield* decode(AutomationCreateArgs, args);
        yield* refuseReserved(input.trigger);
        if (input.machine !== undefined) yield* knownMachine(ports, input.machine);
        const node = yield* findNode(writer, ports, input.target);
        const parts = yield* resolved(resolveTargets(input, resolveIn(writer, node)));
        const { trigger, then } = parts;
        if (trigger === undefined || then === undefined) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "a create names its trigger and at least one action",
            details: { path: trigger === undefined ? "trigger" : "then", retryable: false },
          });
        }
        return yield* ports.submit(command(writer, input.opId, node.id, input.automationId, {
          kind: "create",
          automationId: input.automationId,
          enabled: input.enabled,
          ...(input.machine === undefined ? {} : { machine: input.machine }),
          definition: {
            name: input.name,
            trigger,
            ...(parts.when === undefined ? {} : { when: parts.when }),
            then,
            limits: input.limits,
          },
        }));
      }
      case "automation.edit": {
        const input = yield* decode(AutomationEditArgs, args);
        if (Object.keys(input.change).length === 0) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: "an edit changes at least one of name, trigger, when, then and limits",
            details: { path: "change", retryable: false },
          });
        }
        const node = yield* findNode(writer, ports, input.target);
        const head = yield* findAutomation(yield* ports.automations(writer.canvasName, node.id), input.automation);
        // The change is merged onto the head, so it must be the head it was written on.
        if (head.version !== input.baseVersion) return yield* Effect.fail(staleRefusal(head.version, input.baseVersion));
        yield* refuseReserved(input.change.trigger);
        const parts = yield* resolved(resolveTargets(input.change, resolveIn(writer, node)));
        return yield* ports.submit(command(writer, input.opId, node.id, head.automationId, {
          kind: "edit",
          baseVersion: input.baseVersion,
          definition: editedDefinition(head, input.change, parts),
        }));
      }
      case "automation.move": {
        const input = yield* decode(AutomationMoveArgs, args);
        yield* knownMachine(ports, input.machine);
        const node = yield* findNode(writer, ports, input.target);
        const automation = yield* findAutomation(yield* ports.automations(writer.canvasName, node.id), input.automation);
        return yield* ports.submit(command(writer, input.opId, node.id, automation.automationId, { kind: "set-machine", machine: input.machine }));
      }
      case "automation.enable":
      case "automation.disable":
      case "automation.archive":
      case "automation.run": {
        const input = yield* decode(AutomationOneArgs, args);
        const node = yield* findNode(writer, ports, input.target);
        const automation = yield* findAutomation(yield* ports.automations(writer.canvasName, node.id), input.automation);
        const ruled: AutomationOp = op === "automation.enable"
          ? { kind: "set-enabled", enabled: true }
          : op === "automation.disable"
            ? { kind: "set-enabled", enabled: false }
            : op === "automation.archive"
              ? { kind: "archive" }
              : { kind: "run" };
        return yield* ports.submit(command(writer, input.opId, node.id, automation.automationId, ruled));
      }
    }
  });
