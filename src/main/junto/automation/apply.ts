/**
 * The one write path for an automation command on this machine (plan
 * 0.10/07): the pane's IPC and the overseer's `junto automation` both land
 * here. It is ruled only on the machine that edits the canvas, against the
 * canvas as it stands now; an applied run fires at once, and every applied
 * write is said once so open panes read again.
 */
import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { AutomationOp } from "@shared/automation";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/physics/schema";
import type { ResourceCommand } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import type { WorkErrorBody } from "@shared/work-control";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import type { RulingRecorder } from "../work/ruling-recorder";
import { AutomationRunnerService } from "./live";
import type { AutomationRepository } from "./repository";
import { type AutomationSubmitOutcome, automationEnvOf, submitAutomationCommand } from "./ruler";

export type AutomationsChangedListener = (canvasName: string, nodeId: NodeId) => void;

const listeners = new Set<AutomationsChangedListener>();

/** Returns the unsubscribe. */
export const onAutomationsChanged = (listener: AutomationsChangedListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** This machine's installation id: the writer of the commands it rules. */
const localWriter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ installation_id: Schema.String }),
    execute: () => sql`SELECT installation_id FROM installation WHERE singleton = 1`,
  })(undefined);
  return Option.map(row, (found) => found.installation_id as InstallationId);
});

const notAvailable = (command: ResourceCommand<AutomationOp>, message: string, next_step?: string): AutomationSubmitOutcome => ({
  kind: "refused",
  opId: command.opId,
  root: command.opId,
  error: {
    type: "InputError",
    message,
    details: { reason: "not_available", retryable: false, ...(next_step === undefined ? {} : { next_step }) },
  } satisfies WorkErrorBody,
});

export const applyAutomationCommand = (command: ResourceCommand<AutomationOp>) =>
  Effect.gen(function* () {
    const name = command.canvasName;
    // Automation writes are ruled on the editing machine (02, 07). Until the
    // command channel carries them there, a copy refuses them.
    if (!(yield* (yield* ModelRecords).editsCanvas(name))) {
      return notAvailable(
        command,
        "automations are written on the machine that edits this canvas",
        "Open this canvas on its editing machine to change its automations",
      );
    }
    const writer = yield* localWriter;
    if (Option.isNone(writer)) return notAvailable(command, "this machine has no installation id yet");
    const canvas = yield* (yield* ModelService).canvas(name);
    const outcome = yield* submitAutomationCommand(writer.value, command, rulingContextOf(canvas, () => undefined), automationEnvOf(canvas));
    if (outcome.kind === "refused") return outcome;
    // An applied run fires now, so its firing is in the history read next.
    if (command.op.kind === "run" && outcome.facts.length > 0) {
      const runner = yield* Effect.serviceOption(AutomationRunnerService);
      if (Option.isSome(runner)) yield* runner.value.onRun(name, outcome.automation.automationId);
    }
    for (const listener of listeners) listener(name, command.target.nodeId as NodeId);
    return outcome;
  });

export type AutomationApplyServices = AutomationRepository | ModelRecords | ModelService | RulingRecorder | SqlClient.SqlClient;
