/**
 * The Automations pane's channels (plan 0.10/07). Every answer comes from the
 * core's automation group (src/contract/core/automation.ts), where the
 * automation store, the one write path and the content store live; every
 * applied write reaches the panes from there, the CLI's too. What the pane
 * sends is decoded closed here, so a request this build does not read rejects
 * before the core is asked.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Schema } from "effect";
import type {
  AutomationApplyResponse,
  AutomationCodePutResponse,
  AutomationCodeReadResponse,
  AutomationFiringsResponse,
  AutomationListResponse,
} from "@shared/automation";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  AutomationApplyAsk,
  AutomationCodePutAsk,
  AutomationCodeReadAsk,
  AutomationCore,
  AutomationFiringsAsk,
  AutomationListAsk,
} from "../../contract/core/automation";
import { AppRuntime } from "../runtime";

const closed = { onExcessProperty: "error" } as const;
const decodeList = Schema.decodeUnknownEffect(AutomationListAsk, closed);
const decodeFirings = Schema.decodeUnknownEffect(AutomationFiringsAsk, closed);
const decodeApply = Schema.decodeUnknownEffect(AutomationApplyAsk, closed);
const decodeCodePut = Schema.decodeUnknownEffect(AutomationCodePutAsk, closed);
const decodeCodeRead = Schema.decodeUnknownEffect(AutomationCodeReadAsk, closed);

export const registerAutomationIpc = (ipcMain: Pick<IpcMain, "handle">, core: Context.Context<AutomationCore>): void => {
  const automation = Context.get(core, AutomationCore);
  ipcMain.handle(IPC_CHANNELS.automationList, (_event, canvasName: unknown, input: unknown): Promise<AutomationListResponse> =>
    AppRuntime.runPromise(
      decodeList({ canvasName, request: input }).pipe(Effect.flatMap((ask) => automation.AutomationList(ask))),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.automationFirings, (_event, canvasName: unknown, input: unknown): Promise<AutomationFiringsResponse> =>
    AppRuntime.runPromise(
      decodeFirings({ canvasName, request: input }).pipe(Effect.flatMap((ask) => automation.AutomationFirings(ask))),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.automationApply, (_event, canvasName: unknown, input: unknown): Promise<AutomationApplyResponse> =>
    AppRuntime.runPromise(
      decodeApply({ canvasName, request: input }).pipe(Effect.flatMap((ask) => automation.AutomationApply(ask))),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.automationCodePut, (_event, canvasName: unknown, input: unknown): Promise<AutomationCodePutResponse> =>
    AppRuntime.runPromise(
      decodeCodePut({ canvasName, request: input }).pipe(Effect.flatMap((ask) => automation.AutomationCodePut(ask))),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.automationCodeRead, (_event, canvasName: unknown, input: unknown): Promise<AutomationCodeReadResponse> =>
    AppRuntime.runPromise(
      decodeCodeRead({ canvasName, request: input }).pipe(Effect.flatMap((ask) => automation.AutomationCodeRead(ask))),
    ),
  );
};
