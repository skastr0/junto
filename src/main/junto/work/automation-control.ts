// `junto automation` in main (plan 07, cli L4): decode each verb, find the
// Automations node and the automation, resolve every target against
// `automationTargets`, and hand each write to the ruler as a ResourceCommand
// (02). The store, the ruler and the runner are canvas's (C5) and remote's
// (R2); they reach this file through `AutomationPorts`, so the verbs are whole
// before those land and switch over without changing here.

import { Effect, Result, Schema } from "effect";
import type { Firing } from "@shared/automation";
import {
  AutomationCreateArgs,
  AutomationEditArgs,
  AutomationHistoryArgs,
  AutomationListArgs,
  AutomationOneArgs,
  AutomationShowArgs,
  reservedTriggerRefusal,
  resolveTargets,
  type AutomationCommandOp,
  type AutomationOp,
  type AutomationView,
  type AutomationWriteResult,
} from "@shared/automation-control";
import { parseMentionHref } from "@shared/mention";
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { reaches } from "@shared/region-reach";
import type { ResourceActor, ResourceCommand } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import { isItemId, type ItemId, type OpId } from "@shared/work-ids";
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
  readonly automations: (canvasName: string, nodeId: NodeId) => Effect.Effect<ReadonlyArray<AutomationView>, WorkErrorBody>;
  /** Newest first. */
  readonly firings: (canvasName: string, nodeId: NodeId, query: HistoryQuery) => Effect.Effect<ReadonlyArray<Firing>, WorkErrorBody>;
  readonly submit: (command: ResourceCommand<AutomationCommandOp>) => Effect.Effect<AutomationWriteResult, WorkErrorBody>;
};

export type AutomationCaller = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: Extract<ResourceActor, { readonly kind: "seat" }>;
};

const HISTORY_DEFAULT_LIMIT = 50;

const notBuilt = (what: string): WorkErrorBody => ({
  type: "InputError",
  message: `${what} is not built in this Junto build yet`,
  details: { reason: "not_available", retryable: false },
});

/**
 * Until canvas C5 adds the Automations kind and its store, and remote R2 the
 * local ruler, a canvas has no Automations node: list answers empty and every
 * verb that names a node refuses it as unknown.
 */
export const liveAutomationPorts: AutomationPorts = {
  nodes: () => [],
  automations: () => Effect.fail(notBuilt("the automation store")),
  firings: () => Effect.fail(notBuilt("automation history")),
  submit: () => Effect.fail(notBuilt("the automation ruler")),
};

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

const findNode = (caller: AutomationCaller, ports: AutomationPorts, text: string): Effect.Effect<Node, WorkErrorBody> => {
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
  return reaches(caller.canvas, caller.actor.nodeId, node.id)
    ? Effect.succeed(node)
    : Effect.fail({
        type: "ScopeError",
        message: `${titleOf(node)} is not in this seat's reach`,
        details: { path: "target", reason: "not_in_reach", retryable: false },
      });
};

const findAutomation = (
  views: ReadonlyArray<AutomationView>,
  text: string,
): Effect.Effect<AutomationView, WorkErrorBody> => {
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
  caller: AutomationCaller,
  opId: OpId,
  nodeId: NodeId,
  automationId: ItemId,
  op: AutomationCommandOp,
): ResourceCommand<AutomationCommandOp> => ({
  opId,
  canvasName: caller.canvasName,
  actor: caller.actor,
  target: { kind: "automation", nodeId, itemId: automationId },
  // Basis and the after chain come with remote's pending overlay (R2).
  basis: null,
  after: [],
  op,
});

const resolveIn = (caller: AutomationCaller, node: Node) =>
  automationTargetResolver(caller.canvas, node.id, { kind: "seat", seat: caller.actor.nodeId });

const resolved = <A>(out: { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: WorkErrorBody }) =>
  out.ok ? Effect.succeed(out.value) : Effect.fail(out.error);

const refuseReserved = (trigger: Parameters<typeof reservedTriggerRefusal>[0] | undefined) => {
  const refusal = trigger === undefined ? undefined : reservedTriggerRefusal(trigger);
  return refusal === undefined ? Effect.void : Effect.fail(refusal);
};

/** One automation verb, for a seat the work socket admitted. */
export const handleAutomationOp = (
  op: AutomationOp,
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
          : [yield* findNode(caller, ports, input.target)];
        const automations: Array<AutomationView> = [];
        for (const node of nodes) automations.push(...(yield* ports.automations(caller.canvasName, node.id)));
        return { automations };
      }
      case "automation.show": {
        const input = yield* decode(AutomationShowArgs, args);
        const node = yield* findNode(caller, ports, input.target);
        const automation = yield* findAutomation(yield* ports.automations(caller.canvasName, node.id), input.automation);
        return { automation };
      }
      case "automation.history": {
        const input = yield* decode(AutomationHistoryArgs, args);
        const node = yield* findNode(caller, ports, input.target);
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
      case "automation.create": {
        const input = yield* decode(AutomationCreateArgs, args);
        const node = yield* findNode(caller, ports, input.target);
        const parts = yield* resolved(resolveTargets(input, resolveIn(caller, node)));
        yield* refuseReserved(parts.trigger);
        const { trigger, then } = parts;
        if (trigger === undefined || then === undefined) return yield* Effect.die("a create resolves its trigger and actions");
        return yield* ports.submit(command(caller, input.opId, node.id, input.automationId, {
          kind: "create",
          definition: {
            name: input.name,
            enabled: input.enabled,
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
        const node = yield* findNode(caller, ports, input.target);
        const automation = yield* findAutomation(yield* ports.automations(caller.canvasName, node.id), input.automation);
        const parts = yield* resolved(resolveTargets(input.change, resolveIn(caller, node)));
        yield* refuseReserved(parts.trigger);
        const { name, limits } = input.change;
        return yield* ports.submit(command(caller, input.opId, node.id, automation.automationId, {
          kind: "edit",
          baseVersion: input.baseVersion,
          change: {
            ...(name === undefined ? {} : { name }),
            ...(limits === undefined ? {} : { limits }),
            ...parts,
          },
        }));
      }
      case "automation.enable":
      case "automation.disable":
      case "automation.run": {
        const input = yield* decode(AutomationOneArgs, args);
        const node = yield* findNode(caller, ports, input.target);
        const automation = yield* findAutomation(yield* ports.automations(caller.canvasName, node.id), input.automation);
        const kind = op === "automation.enable" ? "enable" : op === "automation.disable" ? "disable" : "run";
        return yield* ports.submit(command(caller, input.opId, node.id, automation.automationId, { kind }));
      }
    }
  });
