/**
 * The Automations pane's reads and writes (automation/ipc.ts), answered in the
 * core where the automation store and the one write path live. Every applied
 * write, the CLI's too, is published on the pane's own channel as it lands,
 * and main relays that to the windows. A code step's program is put and read
 * as text in this machine's content store.
 */
import { readFile } from "node:fs/promises";
import { Effect, Option, Schema } from "effect";
import { ulid } from "ulid";
import {
  AUTOMATION_CODE_SOURCE_MAX_BYTES,
  AutomationApplyRequest,
  AutomationCodePutRequest,
  AutomationCodeReadRequest,
  AutomationFiringsRequest,
  AutomationListRequest,
  type AutomationApplyResponse,
  type AutomationCodePutResponse,
  type AutomationCodeReadResponse,
  type AutomationFiringsResponse,
  type AutomationListResponse,
} from "@shared/automation";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Refusal, RefusalReason } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import { OpId } from "@shared/work-ids";
import { applyAutomationCommand, onAutomationsChanged } from "../../junto/automation/apply";
import { AutomationRepository } from "../../junto/automation/repository";
import { ContentService } from "../../junto/content/service";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

type Asked = { readonly canvasName: unknown; readonly input: unknown };

declare module "../ops" {
  interface CoreOps {
    "ipc.automation.list": CoreOp<Asked, AutomationListResponse>;
    "ipc.automation.firings": CoreOp<Asked, AutomationFiringsResponse>;
    "ipc.automation.apply": CoreOp<Asked, AutomationApplyResponse>;
    "ipc.automation.codePut": CoreOp<Asked, AutomationCodePutResponse>;
    "ipc.automation.codeRead": CoreOp<Asked, AutomationCodeReadResponse>;
  }
}

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

// Every applied write, from the pane or from an overseer's CLI, reaches the panes.
onAutomationsChanged((canvasName, nodeId) => publish(IPC_CHANNELS.automationsChanged, { canvasName, nodeId }));

coreOps({
  "ipc.automation.list": ({ canvasName, input }) =>
    Effect.gen(function* () {
      const canvas = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationListRequest)(input);
      const repository = yield* AutomationRepository;
      const automations = yield* repository.list(canvas, request.nodeId);
      return { automations, lastOutcomes: yield* repository.lastOutcomes(canvas, request.nodeId) };
    }),

  "ipc.automation.firings": ({ canvasName, input }) =>
    Effect.gen(function* () {
      const canvas = yield* decode(CanvasName)(canvasName);
      const request = yield* decode(AutomationFiringsRequest)(input);
      return { firings: yield* (yield* AutomationRepository).firings(canvas, request) };
    }),

  "ipc.automation.apply": ({ canvasName, input }) =>
    Effect.gen(function* () {
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
    }),

  "ipc.automation.codePut": ({ canvasName, input }) =>
    Effect.gen(function* () {
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
    }),

  "ipc.automation.codeRead": ({ canvasName, input }) =>
    Effect.gen(function* () {
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
    }),
});
