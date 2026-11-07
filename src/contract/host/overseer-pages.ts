/**
 * The overseer's pages, as the core asks main for them. The overseer runs in
 * the core and the browser is Electron's, so each page operation is a call to
 * main (`src/app/core-process/main-side/overseer-pages.ts`), made from
 * `src/core/ops/overseer-pages.ts`.
 *
 * Every refusal is an answer, never an error of the call: each result is a
 * `BrowserResult`, `{ ok: false, code, message }` included. The one failure a
 * call can have is `RpcClientError`, main leaving before it answered. A call
 * that waits on a page (an open, an eval, a screenshot) is interrupted by
 * interrupting its fiber: main aborts the page work it started for it. An open
 * keeps its recheck in the core under `callId`, which main asks back through
 * the core's overseer pages group (`src/contract/core/overseer-pages.ts`).
 *
 * The shapes mirror `src/shared/browser.ts`, `src/shared/ipc.ts` and
 * `src/app/browser/sessions.ts`, which this program may not load: the
 * handlers and the core's callers fail to compile when the two drift.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { BROWSER_SESSION_STATES } from "../../shared/browser";
import { ResolvedPageTarget } from "../core/browser";

const BrowserErrorCode = Schema.Literals([
  "invalid",
  "not_found",
  "forbidden",
  "failed",
  "timeout",
  "cancelled",
  "resource_exhausted",
  "unsupported_capability",
  "unsupported_result",
  "result_too_large",
  "operator_holds",
]);

/** A browser answer: the data, or the refusal with its code. */
export const BrowserResult = <A, I, R>(data: Schema.Codec<A, I, R>) =>
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data }),
    Schema.Struct({ ok: Schema.Literal(false), code: BrowserErrorCode, message: Schema.String }),
  ]);

const BrowserSessionState = Schema.Literals(BROWSER_SESSION_STATES);

export const BrowserSessionInfo = Schema.Struct({
  sessionId: Schema.String,
  ref: Schema.String,
  nodeId: Schema.String,
  url: Schema.String,
  profile: Schema.String,
  state: BrowserSessionState,
  attached: Schema.Boolean,
  title: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.String),
  /** Shown to a seat while the operator holds the page: it is paused, and url, title and error are left out. */
  operatorHolds: Schema.optionalKey(Schema.Literal(true)),
});

export const BrowserStopReceipt = Schema.Struct({
  sessionId: Schema.String,
  ref: Schema.String,
  profile: Schema.String,
  stopped: Schema.Literal(true),
  alreadyStopped: Schema.Boolean,
});

/** A live page session, as the overseer names one. */
export const OverseerPageSession = Schema.Struct({ owner: Schema.String, sessionId: Schema.String });

const Session = { owner: Schema.String, sessionId: Schema.String };
const Fence = { ref: Schema.String, leaseId: Schema.String };

export const OverseerPagesHostRpcs = RpcGroup.make(
  Rpc.make("OverseerPagesSessionsForRef", { payload: { ref: Schema.String }, success: Schema.Array(OverseerPageSession) }),
  Rpc.make("OverseerPagesDeleteSessionsForRef", { payload: { ref: Schema.String }, success: Schema.Array(OverseerPageSession) }),
  Rpc.make("OverseerPagesState", { payload: Session, success: BrowserResult(BrowserSessionInfo) }),
  /** `callId` is the open's recheck in the core, asked back before the page commits. */
  Rpc.make("OverseerPagesOpen", {
    payload: { callId: Schema.Int, owner: Schema.String, target: ResolvedPageTarget, driver: Schema.String },
    success: BrowserResult(BrowserSessionInfo),
  }),
  Rpc.make("OverseerPagesGoto", { payload: { ...Session, url: Schema.String }, success: BrowserResult(BrowserSessionInfo) }),
  Rpc.make("OverseerPagesEval", {
    payload: { ...Session, code: Schema.String },
    success: BrowserResult(Schema.Struct({ result: Schema.Unknown })),
  }),
  Rpc.make("OverseerPagesScreenshot", { payload: Session, success: BrowserResult(Schema.Struct({ png: Schema.Uint8Array })) }),
  Rpc.make("OverseerPagesClose", { payload: Session, success: BrowserResult(BrowserSessionInfo) }),
  Rpc.make("OverseerPagesStop", { payload: Session, success: BrowserResult(BrowserStopReceipt) }),
  /** The fence a node delete holds over a page: sent in order, answered once main has it. */
  Rpc.make("OverseerPagesBeginDelete", { payload: Fence, success: Schema.Void }),
  Rpc.make("OverseerPagesFinishDelete", { payload: Fence, success: Schema.Void }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });
