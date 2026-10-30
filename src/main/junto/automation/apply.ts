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
import { MachineRepository } from "../machines/repository";
import type { RulingRecorder } from "../work/ruling-recorder";
import { AutomationRunnerService } from "./live";
import type { AutomationRepository } from "./repository";
import { type AutomationSubmitOutcome, automationEnvOf, submitAutomationCommand } from "./ruler";

export type AutomationsChangedListener = (canvasName: string, nodeId: NodeId) => void;

/** Returns the unsubscribe. */
export { onAutomationsChanged } from "./changes";
import { notifyAutomationsChanged } from "./changes";

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

/** The pinned name of the machine that edits a canvas; none when that machine is not pinned here. */
const editorName = (canvasName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ machine_name: Schema.String }),
      execute: (name) => sql`SELECT p.machine_name FROM canvases c
        JOIN machine_peers p ON p.installation_id = c.editor_installation_id AND p.retired_at IS NULL
        WHERE c.canvas_name = ${name}`,
    })(canvasName);
    return Option.map(row, (found) => found.machine_name);
  });

const notAvailableBody = (message: string, next_step?: string): WorkErrorBody => ({
  type: "InputError",
  message,
  details: { reason: "not_available", retryable: false, ...(next_step === undefined ? {} : { next_step }) },
});

const notAvailable = (command: ResourceCommand<AutomationOp>, message: string, next_step?: string): AutomationSubmitOutcome => ({
  kind: "refused",
  opId: command.opId,
  root: command.opId,
  error: notAvailableBody(message, next_step),
});

/**
 * Why this machine cannot serve a canvas's automations, none when it edits
 * the canvas: automations and their store live on the editing machine (07,
 * rule 2), so a copy is written and read there, and names where to go.
 */
export const offEditorRefusal = (canvasName: string, verb: "written" | "kept") =>
  Effect.gen(function* () {
    if (yield* (yield* ModelRecords).editsCanvas(canvasName)) return Option.none<WorkErrorBody>();
    const action = verb === "written" ? "change" : "read or change";
    const editor = yield* editorName(canvasName);
    return Option.some(Option.match(editor, {
      onSome: (machine) =>
        notAvailableBody(
          `automations on "${canvasName}" are ${verb} on ${machine}, the machine that edits it`,
          `Open "${canvasName}" on ${machine} to ${action} its automations`,
        ),
      onNone: () =>
        notAvailableBody(
          `automations on "${canvasName}" are ${verb} on the machine that edits it, and that machine is not paired here`,
          `Open "${canvasName}" on its editing machine to ${action} its automations`,
        ),
    }));
  });

export const applyAutomationCommand = (command: ResourceCommand<AutomationOp>) =>
  Effect.gen(function* () {
    const name = command.canvasName;
    // A copy has nothing to write against.
    const refusal = yield* offEditorRefusal(name, "written");
    if (Option.isSome(refusal)) return { kind: "refused", opId: command.opId, root: command.opId, error: refusal.value } satisfies AutomationSubmitOutcome;
    const writer = yield* localWriter;
    if (Option.isNone(writer)) return notAvailable(command, "this machine has no installation id yet");
    const canvas = yield* (yield* ModelService).canvas(name);
    const machines = yield* Effect.serviceOption(MachineRepository);
    const machine = Option.isSome(machines) ? yield* machines.value.machineName.pipe(Effect.option) : Option.none<string>();
    // The ruling installation is stamped on any code this ruling sets (Code steps, check 3).
    const env = { ...automationEnvOf(canvas, Option.getOrUndefined(machine)), rulingInstallation: writer.value };
    const outcome = yield* submitAutomationCommand(writer.value, command, rulingContextOf(canvas, () => undefined), env);
    if (outcome.kind === "refused") return outcome;
    // An applied run fires now, so its firing is in the history read next, when it runs on this machine.
    // Any other applied write reads the canvas now: a canvas's first automation takes its baseline
    // here, so the next change fires instead of becoming that baseline (B1).
    const runner = yield* Effect.serviceOption(AutomationRunnerService);
    if (outcome.facts.length > 0 && Option.isSome(runner)) {
      if (command.op.kind === "run") yield* runner.value.onRun(name, outcome.automation.automationId);
      else yield* runner.value.wake(name).pipe(Effect.catchCause((cause) => Effect.logWarning("automation pass after a save failed", cause)));
    }
    notifyAutomationsChanged(name, command.target.nodeId as NodeId);
    return outcome;
  });

export type AutomationApplyServices = AutomationRepository | ModelRecords | ModelService | RulingRecorder | SqlClient.SqlClient;
