/**
 * The window's browser, where it needs the core (src/app/browser/ipc.ts): a
 * page ref resolved against the canvases, the pool limits from Settings, and
 * the operator's box comment. Main draws the box and takes its shot, since
 * the page is Electron's; the core stages the shot, posts it and releases it
 * (`src/core/ops/ipc-browser.ts`), so the staged shots live beside the
 * content store that holds their bytes.
 *
 * Every refusal is an answer the window reads as data. The shapes mirror
 * `src/core/browser/page-target.ts` and `src/core/work/page-box-comment.ts`,
 * which this program may not load: the handlers and main's callers fail to
 * compile when the two drift.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { MailMessageId } from "../../shared/crew";
import { coreClient } from "./link";

/** A page ref resolved against the canvas: URL, profile and node always come from the page row. */
export const ResolvedPageTarget = Schema.Struct({
  ref: Schema.String,
  nodeId: Schema.String,
  url: Schema.String,
  profile: Schema.String,
});

export const PageTargetResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: ResolvedPageTarget }),
  Schema.Struct({ ok: Schema.Literal(false), code: Schema.Literals(["invalid", "not_found", "failed"]), message: Schema.String }),
]);
export type PageTargetResult = typeof PageTargetResult.Type;

export const BrowserPoolLimits = Schema.Struct({ maxVisibleSurfaces: Schema.Number, maxWarmSessions: Schema.Number });

/** The page a browser session shows: its canvas and node. */
export const OperatorPage = Schema.Struct({ canvasName: Schema.String, nodeId: Schema.String });

const PageRect = Schema.Struct({ x: Schema.Number, y: Schema.Number, w: Schema.Number, h: Schema.Number });

/** The shot of a box the operator drew, as main's session took it. */
export const DrawnPageShot = Schema.Struct({
  png: Schema.Uint8Array,
  /** The committed document's url when the shot was taken. */
  url: Schema.String,
  scroll: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
  rect: PageRect,
});

const PageBoxRefused = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.Literals(["invalid", "failed"]),
  message: Schema.String,
});

/** A drawn box with the shot the core staged for it, as the composer shows it. */
const OperatorPageBoxDraft = Schema.Struct({
  shotId: Schema.String,
  rect: PageRect,
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  png: Schema.Uint8Array,
});

export const OperatorPageBoxDrawn = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("drawn"), draft: OperatorPageBoxDraft }),
      Schema.Struct({ kind: Schema.Literal("ended") }),
    ]),
  }),
  PageBoxRefused,
]);

export const OperatorPageBoxCommented = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Struct({ messageId: MailMessageId, threadId: MailMessageId }) }),
  PageBoxRefused,
]);

/** Settings could not be read, so the pool has no limits to give. */
export class BrowserPoolLimitsUnavailable extends Schema.TaggedError<BrowserPoolLimitsUnavailable>()(
  "BrowserPoolLimitsUnavailable",
  { message: Schema.String },
) {}

export const BrowserRpcs = RpcGroup.make(
  Rpc.make("BrowserPageTarget", { payload: { ref: Schema.String }, success: PageTargetResult }),
  // Settings.browser is the sole durable source of the pool limits.
  Rpc.make("BrowserPoolLimits", { success: BrowserPoolLimits, error: BrowserPoolLimitsUnavailable }),
  Rpc.make("BrowserPageBoxStage", {
    payload: { sessionId: Schema.String, page: OperatorPage, shot: DrawnPageShot },
    success: OperatorPageBoxDrawn,
  }),
  /** `page` is absent when the session no longer shows one; the staged shot is then dropped. */
  Rpc.make("BrowserPageBoxPost", {
    payload: { page: Schema.optionalKey(OperatorPage), sessionId: Schema.String, shotId: Schema.String, text: Schema.String },
    success: OperatorPageBoxCommented,
  }),
  Rpc.make("BrowserPageBoxDiscard", { payload: { sessionId: Schema.String, shotId: Schema.String } }),
  /** Every staged shot of a session that ended. */
  Rpc.make("BrowserPageBoxReleaseSession", { payload: { sessionId: Schema.String } }),
).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the browser group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class BrowserCore extends Context.Service<BrowserCore, RpcClient.FromGroup<typeof BrowserRpcs, RpcClientError.RpcClientError>>()(
  "@junto/contract/BrowserCore",
) {
  static readonly layer = Layer.effect(BrowserCore, coreClient(BrowserRpcs));
}
