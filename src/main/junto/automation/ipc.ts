/**
 * The Automations pane's IPC (plan 0.10/07): list and firings read the store;
 * apply is the operator's write, ruled here as a resource command from the
 * operator when this machine edits the canvas. Every applied write is
 * broadcast so open panes reread.
 */
import type { IpcMain } from "electron";
import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ulid } from "ulid";
import {
  AutomationApplyRequest,
  type AutomationApplyResponse,
  AutomationFiringsRequest,
  type AutomationFiringsResponse,
  AutomationListRequest,
  type AutomationListResponse,
  type AutomationsChanged,
} from "@shared/automation";
import type { InstallationId } from "@shared/installation-id";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Refusal, RefusalReason } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import type { WorkErrorBody } from "@shared/work-control";
import { OpId } from "@shared/work-ids";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import type { RulingRecorder } from "../work/ruling-recorder";
import { AutomationRepository } from "./repository";
import { automationEnvOf, submitAutomationCommand } from "./ruler";

export type AutomationsRun = <A, E>(
  effect: Effect.Effect<A, E, AutomationRepository | ModelRecords | ModelService | RulingRecorder | SqlClient.SqlClient>,
) => Promise<A>;

const CanvasName = Schema.String.check(Schema.isMinLength(1));
const decode = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" });

/** A ruler's refusal, as the pane reads it. */
const refusalOf = (error: WorkErrorBody): Refusal => {
  const details = (error.details ?? {}) as { readonly reason?: RefusalReason; readonly expected?: unknown; readonly next_step?: string };
  return {
    reason: details.reason ?? "invalid_input",
    message: error.message,
    ...(details.expected === undefined ? {} : { expected: details.expected }),
    ...(details.next_step === undefined ? {} : { next_step: details.next_step }),
  };
};

/** This machine's installation id: the writer of the operator's commands. */
const localWriter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ installation_id: Schema.String }),
    execute: () => sql`SELECT installation_id FROM installation WHERE singleton = 1`,
  })(undefined);
  return Option.map(row, (found) => found.installation_id as InstallationId);
});

export const automationIpcHandlers = (run: AutomationsRun, changed: (event: AutomationsChanged) => void) => ({
  list: (canvasName: unknown, input: unknown): Promise<AutomationListResponse> =>
    run(Effect.gen(function* () {
      const canvas = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationListRequest)(input);
      return { automations: yield* (yield* AutomationRepository).list(canvas, request.nodeId) };
    })),

  firings: (canvasName: unknown, input: unknown): Promise<AutomationFiringsResponse> =>
    run(Effect.gen(function* () {
      const canvas = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationFiringsRequest)(input);
      return { firings: yield* (yield* AutomationRepository).firings(canvas, request) };
    })),

  apply: (canvasName: unknown, input: unknown): Promise<AutomationApplyResponse> =>
    run(Effect.gen(function* () {
      const name = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationApplyRequest)(input);
      // Automation writes are ruled on the editing machine (02, 07). Until the
      // command channel carries them there, a copy refuses them.
      if (!(yield* (yield* ModelRecords).editsCanvas(name))) {
        return {
          kind: "refused",
          refusal: {
            reason: "not_available",
            message: "automations are written on the machine that edits this canvas",
            next_step: "Open this canvas on its editing machine to change its automations",
          },
        } as const;
      }
      const writer = yield* localWriter;
      if (Option.isNone(writer)) {
        return { kind: "refused", refusal: { reason: "not_available", message: "this machine has no installation id yet" } } as const;
      }
      const canvas = yield* (yield* ModelService).canvas(name);
      // The operator's command is ruled against the canvas as it stands now.
      const outcome = yield* submitAutomationCommand(
        writer.value,
        {
          opId: OpId.make(ulid()),
          canvasName: name,
          actor: { kind: "operator" },
          target: {
            kind: "automation",
            nodeId: request.nodeId,
            ...(request.op.kind === "create" ? {} : { itemId: request.automationId }),
          },
          basis: null,
          after: [],
          op: request.op,
        },
        rulingContextOf(canvas, () => undefined),
        automationEnvOf(canvas),
      );
      if (outcome.kind === "refused") return { kind: "refused", refusal: refusalOf(outcome.error) } as const;
      changed({ canvasName: name, nodeId: request.nodeId });
      return outcome.archived ? ({ kind: "applied" } as const) : ({ kind: "applied", automation: outcome.automation } as const);
    })),
});

/** One line in the app's IPC registration. */
export const registerAutomationIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: AutomationsChanged) => void,
  run: AutomationsRun,
): void => {
  const handlers = automationIpcHandlers(run, (event) => broadcast(IPC_CHANNELS.automationsChanged, event));
  ipcMain.handle(IPC_CHANNELS.automationList, (_event, canvasName: unknown, input: unknown) => handlers.list(canvasName, input));
  ipcMain.handle(IPC_CHANNELS.automationFirings, (_event, canvasName: unknown, input: unknown) => handlers.firings(canvasName, input));
  ipcMain.handle(IPC_CHANNELS.automationApply, (_event, canvasName: unknown, input: unknown) => handlers.apply(canvasName, input));
};
