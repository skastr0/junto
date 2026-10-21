/**
 * The Automations pane's IPC (plan 0.10/07): list and firings read the store;
 * apply is the operator's write, a resource command from the operator through
 * the one write path (apply.ts). Every applied write, the CLI's too, is
 * broadcast so open panes reread.
 */
import type { IpcMain } from "electron";
import { Effect, Option, Schema } from "effect";
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
import { IPC_CHANNELS } from "@shared/ipc";
import type { Refusal, RefusalReason } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import { OpId } from "@shared/work-ids";
import { applyAutomationCommand, type AutomationApplyServices, onAutomationsChanged } from "./apply";
import { AutomationRepository } from "./repository";

export type AutomationsRun = <A, E>(effect: Effect.Effect<A, E, AutomationApplyServices>) => Promise<A>;

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

export const automationIpcHandlers = (run: AutomationsRun, changed: (event: AutomationsChanged) => void) => {
  // Every applied write, from the pane or from an overseer's CLI, reaches the panes.
  onAutomationsChanged((canvasName, nodeId) => changed({ canvasName, nodeId }));
  return {
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
      const outcome = yield* applyAutomationCommand({
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
      });
      if (outcome.kind === "refused") return { kind: "refused", refusal: refusalOf(outcome.error) } as const;
      return outcome.archived ? ({ kind: "applied" } as const) : ({ kind: "applied", automation: outcome.automation } as const);
    })),
  };
};

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
