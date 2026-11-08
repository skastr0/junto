/**
 * The Automations pane's reads and writes, answered in the core where the
 * automation store, the one write path and the content store live. Every
 * applied write, the CLI's too, is published on the pane's own channel as it
 * lands, and main relays that to the windows. A code step's program is put
 * and read as text in this machine's content store.
 *
 * Each call names a canvas and carries one request. Main decodes both closed,
 * from the `Automation...Ask` schemas below, so the core is only handed
 * requests it can read. A refusal by the ruler or the content store is an
 * answer the pane reads; the reads and the apply fail only when the store
 * could not be reached.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import {
  AutomationApplyRequest,
  AutomationApplyResponse,
  AutomationCodePutRequest,
  AutomationCodePutResponse,
  AutomationCodeReadRequest,
  AutomationCodeReadResponse,
  AutomationFiringsRequest,
  AutomationFiringsResponse,
  AutomationListRequest,
  AutomationListResponse,
} from "../../shared/automation";
import { coreClient } from "./link";

/** The automation store, the ruler or the content store failed under the call; the words are the pane's to show. */
export class AutomationUnavailable extends Schema.TaggedError<AutomationUnavailable>()("AutomationUnavailable", {
  message: Schema.String,
}) {}

const CanvasName = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

/** A canvas and one request, as the pane asks. */
const asking = <Request extends Schema.Top>(request: Request) => Schema.Struct({ canvasName: CanvasName, request });

export const AutomationListAsk = asking(AutomationListRequest);
export const AutomationFiringsAsk = asking(AutomationFiringsRequest);
export const AutomationApplyAsk = asking(AutomationApplyRequest);
export const AutomationCodePutAsk = asking(AutomationCodePutRequest);
export const AutomationCodeReadAsk = asking(AutomationCodeReadRequest);

export const AutomationRpcs = RpcGroup.make(
  Rpc.make("AutomationList", { payload: AutomationListAsk, success: AutomationListResponse, error: AutomationUnavailable }),
  Rpc.make("AutomationFirings", {
    payload: AutomationFiringsAsk,
    success: AutomationFiringsResponse,
    error: AutomationUnavailable,
  }),
  Rpc.make("AutomationApply", { payload: AutomationApplyAsk, success: AutomationApplyResponse, error: AutomationUnavailable }),
  Rpc.make("AutomationCodePut", { payload: AutomationCodePutAsk, success: AutomationCodePutResponse }),
  Rpc.make("AutomationCodeRead", { payload: AutomationCodeReadAsk, success: AutomationCodeReadResponse }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the automation group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class AutomationCore extends Context.Service<
  AutomationCore,
  RpcClient.FromGroup<typeof AutomationRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/AutomationCore") {
  static readonly layer = Layer.effect(AutomationCore, coreClient(AutomationRpcs));
}
