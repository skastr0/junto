/**
 * What the browser composition in main keeps in the core's database: the
 * origins a seat ran code in, and the browser profile registry. Main holds no
 * SQL client; it asks the core here (`src/core/ops/browser.ts`), and its
 * store adapters (`src/app/core-process/main-side/browser.ts`) reach the group
 * through the client service below.
 *
 * Each profile transaction is whole, data in and data out. A refusal by the
 * registry fails the call with `BrowserProfileRefused`, its code kept as it
 * crosses, and main turns it back into its own `BrowserProfileError`. The
 * shapes mirror `src/node/browser/profiles.ts` and
 * `src/node/browser/touched-origins.ts`, which this program may not load: the
 * handlers and main's adapters fail to compile when the two drift.
 */
import { Context, Layer, Schema } from "effect";
import { Rpc, RpcGroup, type RpcClient, type RpcClientError } from "effect/rpc";
import { coreClient } from "./link";

/** One (profile, origin) a seat ran code in. */
export const BrowserTouchedOrigin = Schema.Struct({ profile: Schema.String, origin: Schema.String });
export type BrowserTouchedOrigin = typeof BrowserTouchedOrigin.Type;

export const BrowserProfileRecord = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  lastUsedAt: Schema.optionalKey(Schema.String),
});

const RegistryFields = {
  defaultProfile: Schema.String,
  canvasDefaults: Schema.Record(Schema.String, Schema.String),
  maxWarmSessions: Schema.Number,
  maxVisibleSurfaces: Schema.Number,
  profiles: Schema.Array(BrowserProfileRecord),
};

export const BrowserProfileWipePaths = Schema.Struct({
  storagePath: Schema.String,
  userDataPath: Schema.String,
  sessionDataPath: Schema.String,
});

export const BrowserProfilePendingWipe = Schema.Struct({
  ...BrowserProfileWipePaths.fields,
  wipeId: Schema.String,
  profileId: Schema.String,
  partition: Schema.String,
  requestedAt: Schema.String,
  stage: Schema.Literals(["live_clear_pending", "restart_delete_pending"]),
});

export const BrowserProfileStateReady = Schema.Struct({ ...RegistryFields, phase: Schema.Literal("ready") });

export const BrowserProfileStatePending = Schema.Struct({
  ...RegistryFields,
  phase: Schema.Literal("wipe_pending"),
  pendingWipe: BrowserProfilePendingWipe,
});

export const BrowserProfileState = Schema.Union([BrowserProfileStateReady, BrowserProfileStatePending]);

/** A pending wipe as its begin step records it. */
export const BrowserProfileWipeBegin = Schema.Struct({
  wipeId: Schema.String,
  profileId: Schema.String,
  partition: Schema.String,
  requestedAt: Schema.String,
  paths: BrowserProfileWipePaths,
});

/** The registry refused a transaction; `code` says why, as the registry's own error does. */
export class BrowserProfileRefused extends Schema.TaggedError<BrowserProfileRefused>()("BrowserProfileRefused", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.Literals(["invalid", "not_found", "io", "forbidden", "corrupt", "pending_wipe"])),
}) {}

/** The touched-origin rows could not be read or written. */
export class BrowserTouchedOriginsUnavailable extends Schema.TaggedError<BrowserTouchedOriginsUnavailable>()(
  "BrowserTouchedOriginsUnavailable",
  { message: Schema.String },
) {}

export const BrowserStoreRpcs = RpcGroup.make(
  Rpc.make("BrowserStoreOriginRecord", { payload: { entry: BrowserTouchedOrigin }, error: BrowserTouchedOriginsUnavailable }),
  Rpc.make("BrowserStoreOriginList", { success: Schema.Array(BrowserTouchedOrigin), error: BrowserTouchedOriginsUnavailable }),
  Rpc.make("BrowserStoreOriginRemove", {
    payload: { entries: Schema.Array(BrowserTouchedOrigin) },
    error: BrowserTouchedOriginsUnavailable,
  }),
  Rpc.make("BrowserStoreOriginRemoveProfile", { payload: { profile: Schema.String }, error: BrowserTouchedOriginsUnavailable }),
  /** The stored state, or `initial` written first when nothing is. */
  Rpc.make("BrowserStoreProfileInitialize", {
    payload: { initial: BrowserProfileStateReady },
    success: BrowserProfileState,
    error: BrowserProfileRefused,
  }),
  Rpc.make("BrowserStoreProfileCreate", { payload: { record: BrowserProfileRecord }, error: BrowserProfileRefused }),
  Rpc.make("BrowserStoreProfileTouch", { payload: { id: Schema.String, at: Schema.String }, error: BrowserProfileRefused }),
  Rpc.make("BrowserStoreProfileBeginWipe", {
    payload: { begin: BrowserProfileWipeBegin },
    success: BrowserProfileStatePending,
    error: BrowserProfileRefused,
  }),
  Rpc.make("BrowserStoreProfileMarkRestartPending", { payload: { wipeId: Schema.String }, error: BrowserProfileRefused }),
  Rpc.make("BrowserStoreProfileFinalizeWipe", {
    payload: { expected: BrowserProfilePendingWipe },
    success: BrowserProfileStateReady,
    error: BrowserProfileRefused,
  }),
).annotate(Rpc.ParseOptions, { onExcessProperty: "error" });

/** Main's client of the browser store group. A call fails with `RpcClientError` when the core it asked left before it answered. */
export class BrowserStoreCore extends Context.Service<
  BrowserStoreCore,
  RpcClient.FromGroup<typeof BrowserStoreRpcs, RpcClientError.RpcClientError>
>()("@junto/contract/BrowserStoreCore") {
  static readonly layer = Layer.effect(BrowserStoreCore, coreClient(BrowserStoreRpcs));
}
