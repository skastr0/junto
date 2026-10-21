/**
 * The ruler for automation commands (plan 0.10/07 on 02), on the editing
 * machine. `submitAutomationCommand` rules one command with the shared
 * automation domain against the stored heads, folds the facts it applied and
 * records the ruling through the RulingRecorder, all in one transaction. A
 * command already ruled (same writer, same opId) returns its first ruling and
 * writes nothing.
 *
 * A `run` op applies an `automation.run` fact and nothing else here: the
 * caller hands the applied run to the runner once the transaction commits.
 */
import { Effect, Option, Result, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { Automation, AutomationId, AutomationOp } from "@shared/automation";
import {
  AutomationFact,
  automationDomain,
  type AutomationEnv,
  type AutomationState,
} from "@shared/automation-domain";
import type { InstallationId } from "@shared/installation-id";
import type { Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { automationTargets } from "@shared/region-reach";
import {
  commandKey,
  rule,
  type CommandKey,
  type ResourceCommand,
  type ResourceRuling,
  type RulingContext,
} from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";
import { StateTransactionOperation } from "../state/service";
import type { RulingRecord } from "../work/resource-rulings";
import { RulingRecorder } from "../work/ruling-recorder";
import { AutomationPersistenceError, AutomationRepository } from "./repository";

export type AutomationSubmitOutcome =
  | {
      readonly kind: "applied";
      readonly opId: OpId;
      /** The automation as the ruling left it, archived or not. */
      readonly automation: Automation;
      readonly archived: boolean;
      /** The facts this ruling applied; empty when a retry is answered from the stored ruling. */
      readonly facts: ReadonlyArray<AutomationFact>;
    }
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody; readonly root: OpId };

/** Who may be written to and who is an overseer, read from the canvas the ruler holds now. */
export const automationEnvOf = (canvas: Canvas): AutomationEnv => ({
  targetsOf: (nodeId, author) => new Set(automationTargets(canvas, nodeId, author).map((node) => node.id)),
  isOverseer: (seat: NodeId) => {
    const node = canvas.nodes.get(seat);
    return node?.kind === "agent" && node.overseer;
  },
});

/** What the ruler keeps of a ruling: enough to answer a replay. */
const StoredRuling = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("applied"), automationId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("refused"), error: Schema.Unknown, root: Schema.String }),
]);
const decodeStoredRuling = Schema.decodeUnknownResult(StoredRuling);
const encodeFact = Schema.encodeSync(AutomationFact);
type Json = typeof Schema.Json.Type;
/** The facts as the ruling exchange carries them: encoded, one or more. */
const encodedFacts = ([first, ...rest]: readonly [AutomationFact, ...AutomationFact[]]): readonly [Json, ...Json[]] => [
  encodeFact(first) as Json,
  ...rest.map((fact) => encodeFact(fact) as Json),
];

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/** The automation a command names: the created id, or the target item. */
const automationIdOf = (command: ResourceCommand<AutomationOp>): AutomationId | undefined =>
  command.op.kind === "create" ? command.op.automationId : command.target.itemId;

const unreadable = (what: string) =>
  AutomationPersistenceError.make({ operation: "submit", message: `${what} is unreadable`, cause: undefined });

export const submitAutomationCommand = Effect.fn("automations.submit")(function* (
  writer: InstallationId,
  command: ResourceCommand<AutomationOp>,
  context: RulingContext,
  env: AutomationEnv,
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AutomationRepository;
  const recorder = yield* RulingRecorder;
  const canvas = command.canvasName;

  const rulingRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ opId: Schema.String }),
    Result: Schema.Struct({ ruling_json: Schema.String }),
    execute: ({ opId }) => sql`
      SELECT ruling_json FROM resource_rulings
      WHERE canvas_name = ${canvas} AND writer = ${writer} AND op_id = ${opId}`,
  });

  const headOf = (state: AutomationState, automationId: AutomationId, facts: ReadonlyArray<AutomationFact>) =>
    Effect.gen(function* () {
      const entry = state.get(automationId);
      if (entry === undefined) return yield* unreadable(`automation ${automationId}`);
      return { kind: "applied" as const, opId: command.opId, automation: entry.automation, archived: entry.archived, facts };
    });

  return yield* Effect.gen(function* () {
    const prior = yield* rulingRow({ opId: command.opId });
    if (Option.isSome(prior)) {
      const stored = decodeStoredRuling(parse(prior.value.ruling_json));
      if (Result.isFailure(stored)) return yield* unreadable(`the ruling of ${command.opId}`);
      if (stored.success.kind === "refused") {
        return {
          kind: "refused" as const,
          opId: command.opId,
          error: stored.success.error as WorkErrorBody,
          root: stored.success.root as OpId,
        };
      }
      return yield* headOf(yield* repository.loadState(canvas), stored.success.automationId as AutomationId, []);
    }

    const state = yield* repository.loadState(canvas);
    // Earlier rulings a command's `after` names, so a refused root refuses it too.
    const rulings = new Map<CommandKey, ResourceRuling<AutomationFact>>();
    for (const opId of command.after) {
      const row = yield* rulingRow({ opId });
      if (Option.isNone(row)) continue;
      const stored = decodeStoredRuling(parse(row.value.ruling_json));
      if (Result.isSuccess(stored) && stored.success.kind === "refused") {
        rulings.set(commandKey(writer, opId), {
          kind: "refused",
          opId,
          error: stored.success.error as WorkErrorBody,
          root: stored.success.root as OpId,
        });
      }
    }
    const at = Date.now();
    const ruled = rule(automationDomain(() => at, env), { state, rulings }, writer, command, context);
    const ruling = ruled.ruling;
    let outcome: AutomationSubmitOutcome;
    if (ruling.kind === "applied") {
      yield* repository.applyFacts(canvas, ruling.facts);
      const automationId = automationIdOf(command);
      // The domain refuses a command with no automation, so an applied one always names it.
      if (automationId === undefined) return yield* Effect.die("an applied automation ruling names no automation");
      outcome = yield* headOf(ruled.ruled.state, automationId, ruling.facts);
    } else {
      outcome = { kind: "refused", opId: command.opId, error: ruling.error, root: ruling.root };
    }
    const record: RulingRecord =
      outcome.kind === "applied"
        ? { kind: "applied", automationId: outcome.automation.automationId }
        : { kind: "refused", error: outcome.error, root: outcome.root };
    // The ruling and its facts commit together, or neither does.
    yield* recorder.record({
      canvasName: canvas,
      writer,
      command,
      kind: "automation",
      record,
      ruling: ruling.kind === "applied" ? { ...ruling, facts: encodedFacts(ruling.facts) } : ruling,
      at: new Date(at).toISOString(),
    });
    return outcome;
  }).pipe(
    sql.withTransaction,
    Effect.provideService(StateTransactionOperation, "automations.submit"),
    Effect.mapError((cause) =>
      cause instanceof AutomationPersistenceError
        ? cause
        : AutomationPersistenceError.make({ operation: "submit", message: cause.message, cause }),
    ),
  );
});
