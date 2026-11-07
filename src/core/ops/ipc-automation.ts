/**
 * The core's handlers of the automation group (src/contract/core/automation.ts):
 * the Automations pane's reads and writes (automation/ipc.ts), answered here
 * where the automation store and the one write path live. Every applied
 * write, the CLI's too, is published on the pane's own channel as it lands
 * while this server runs, and main relays that to the windows. A code step's
 * program is put and read as text in this machine's content store.
 */
import { readFile } from "node:fs/promises";
import { Effect, Option } from "effect";
import { ulid } from "ulid";
import { AUTOMATION_CODE_SOURCE_MAX_BYTES } from "@shared/automation";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Refusal, RefusalReason } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import { OpId } from "@shared/work-ids";
import type { ContentRef } from "@shared/wire/content-ref";
import { AutomationRpcs, AutomationUnavailable } from "../../contract/core/automation";
import { applyAutomationCommand, onAutomationsChanged } from "../automation/apply";
import { AutomationRepository } from "../automation/repository";
import { ContentService } from "../content/service";
import { CorePushes } from "../push";

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

/** What failed under a call, in its own words. */
const unavailable = (error: unknown) =>
  new AutomationUnavailable({ message: error instanceof Error ? error.message : String(error) });

/** A program put in this machine's content store as text, held for the canvas's code. */
export const putAutomationCode = (canvasName: string, text: string) =>
  Effect.gen(function* () {
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return codeRefused("this machine has no content store");
    const put = yield* content.value
      .put({
        source: text,
        mediaType: "text/plain; charset=utf-8",
        // Held for the canvas's code, so a collection never takes a program an automation names.
        owner: { kind: "other", canvasName, nodeId: "automation-code", recordId: ulid() },
      })
      .pipe(Effect.result);
    return put._tag === "Success" ? ({ kind: "put", ref: put.success.ref } as const) : codeRefused("the code could not be stored");
  });

/** A program read back as text from this machine's content store, by the ref an automation names. */
export const readAutomationCode = (ref: ContentRef) =>
  Effect.gen(function* () {
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content) || ref.byteLength > AUTOMATION_CODE_SOURCE_MAX_BYTES) {
      return codeRefused("this machine does not hold that code", "not_available");
    }
    const opened = yield* content.value.openForRead(ref).pipe(Effect.orElseSucceed(() => ({ state: "unavailable" }) as const));
    if (opened.state !== "verified") return codeRefused("this machine does not hold that code", "not_available");
    const text = yield* Effect.tryPromise(() => readFile(opened.path, "utf8")).pipe(Effect.orElseSucceed(() => undefined));
    return text === undefined ? codeRefused("the code could not be read", "not_available") : ({ kind: "read", text } as const);
  });

export const AutomationHandlers = AutomationRpcs.toLayer(
  Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    const pushes = yield* CorePushes;
    // Every applied write, from the pane or from an overseer's CLI, reaches the panes. A push is a synchronous send on the port.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        onAutomationsChanged((canvasName, nodeId) =>
          Effect.runSync(pushes.publish(IPC_CHANNELS.automationsChanged, { canvasName, nodeId })),
        ),
      ),
      (stop) => Effect.sync(stop),
    );
    return {
      AutomationList: ({ canvasName, request }) =>
        Effect.gen(function* () {
          const automations = yield* repository.list(canvasName, request.nodeId);
          return { automations, lastOutcomes: yield* repository.lastOutcomes(canvasName, request.nodeId) };
        }).pipe(Effect.mapError(unavailable)),

      AutomationFirings: ({ canvasName, request }) =>
        repository.firings(canvasName, request).pipe(
          Effect.map((firings) => ({ firings })),
          Effect.mapError(unavailable),
        ),

      AutomationApply: ({ canvasName, request }) =>
        Effect.gen(function* () {
          const outcome = yield* applyAutomationCommand({
            opId: OpId.make(ulid()),
            canvasName,
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
        }).pipe(Effect.mapError(unavailable)),

      AutomationCodePut: ({ canvasName, request }) => putAutomationCode(canvasName, request.text),

      AutomationCodeRead: ({ request }) => readAutomationCode(request.ref),
    };
  }),
);
