/**
 * The Automations pane's IPC (plan 0.10/07): list and firings read the store;
 * apply is the operator's write, a resource command from the operator through
 * the one write path (apply.ts). Every applied write, the CLI's too, is
 * broadcast so open panes reread. A code step's program is put and read as
 * text in this machine's content store (0.11/05, Code steps).
 */
import { readFile } from "node:fs/promises";
import type { IpcMain } from "electron";
import { Effect, Option, Schema } from "effect";
import { ulid } from "ulid";
import {
  AUTOMATION_CODE_SOURCE_MAX_BYTES,
  AutomationApplyRequest,
  type AutomationApplyResponse,
  AutomationCodePutRequest,
  type AutomationCodePutResponse,
  AutomationCodeReadRequest,
  type AutomationCodeReadResponse,
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
import { ContentService } from "../content/service";
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

const codeRefused = (message: string, reason: RefusalReason = "invalid_input") =>
  ({ kind: "refused", refusal: { reason, message } }) as const;

export const automationIpcHandlers = (run: AutomationsRun, changed: (event: AutomationsChanged) => void) => {
  // Every applied write, from the pane or from an overseer's CLI, reaches the panes.
  onAutomationsChanged((canvasName, nodeId) => changed({ canvasName, nodeId }));
  return {
  list: (canvasName: unknown, input: unknown): Promise<AutomationListResponse> =>
    run(Effect.gen(function* () {
      const canvas = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationListRequest)(input);
      const repository = yield* AutomationRepository;
      const automations = yield* repository.list(canvas, request.nodeId);
      return { automations, lastOutcomes: yield* repository.lastOutcomes(canvas, request.nodeId) };
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

  codePut: (canvasName: unknown, input: unknown): Promise<AutomationCodePutResponse> =>
    run(Effect.gen(function* () {
      const name = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationCodePutRequest)(input);
      const content = yield* Effect.serviceOption(ContentService);
      if (Option.isNone(content)) return codeRefused("this machine has no content store");
      const put = yield* content.value
        .put({
          source: request.text,
          mediaType: "text/plain; charset=utf-8",
          // Held for the canvas's code, so a collection never takes a program an automation names.
          owner: { kind: "other", canvasName: name, nodeId: "automation-code", recordId: ulid() },
        })
        .pipe(Effect.result);
      return put._tag === "Success" ? ({ kind: "put", ref: put.success.ref } as const) : codeRefused("the code could not be stored");
    })),

  codeRead: (canvasName: unknown, input: unknown): Promise<AutomationCodeReadResponse> =>
    run(Effect.gen(function* () {
      yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationCodeReadRequest)(input);
      const content = yield* Effect.serviceOption(ContentService);
      if (Option.isNone(content) || request.ref.byteLength > AUTOMATION_CODE_SOURCE_MAX_BYTES) {
        return codeRefused("this machine does not hold that code", "not_available");
      }
      const opened = yield* content.value.openForRead(request.ref).pipe(Effect.orElseSucceed(() => ({ state: "unavailable" }) as const));
      if (opened.state !== "verified") return codeRefused("this machine does not hold that code", "not_available");
      const text = yield* Effect.tryPromise(() => readFile(opened.path, "utf8")).pipe(Effect.orElseSucceed(() => undefined));
      return text === undefined ? codeRefused("the code could not be read", "not_available") : ({ kind: "read", text } as const);
    })),
  };
};

/** One line in the app's IPC registration: the handlers answer in the core (ops/ipc-automation.ts). */
export const registerAutomationIpc = (
  ipcMain: Pick<IpcMain, "handle">,
  handlers: ReturnType<typeof automationIpcHandlers>,
): void => {
  ipcMain.handle(IPC_CHANNELS.automationList, (_event, canvasName: unknown, input: unknown) => handlers.list(canvasName, input));
  ipcMain.handle(IPC_CHANNELS.automationFirings, (_event, canvasName: unknown, input: unknown) => handlers.firings(canvasName, input));
  ipcMain.handle(IPC_CHANNELS.automationApply, (_event, canvasName: unknown, input: unknown) => handlers.apply(canvasName, input));
  ipcMain.handle(IPC_CHANNELS.automationCodePut, (_event, canvasName: unknown, input: unknown) => handlers.codePut(canvasName, input));
  ipcMain.handle(IPC_CHANNELS.automationCodeRead, (_event, canvasName: unknown, input: unknown) => handlers.codeRead(canvasName, input));
};
