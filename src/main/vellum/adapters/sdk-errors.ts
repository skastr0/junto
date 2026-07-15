import {
  ApiDecodeError,
  ApiRequestError,
  ApiResponseError,
  CommandInputError,
  ConfigurationError,
  JsonInputError,
  MissingApiKeyError,
  type AppError,
} from "@skastr0/tower-sdk";
import {
  QuasarConfigError,
  QuasarDecodeError,
  QuasarServerError,
  QuasarTransportError,
  type QuasarError,
} from "@skastr0/quasar-sdk";

// Shared error-to-string projection for every tower.ts/tower-browse.ts/
// quasar.ts SDK call site. Both @skastr0/tower-sdk's AppError and
// @skastr0/quasar-sdk's QuasarError are closed unions of Schema.TaggedError
// classes — checked here by `instanceof` against the concrete classes each
// SDK actually exports, not a structural "does it have a .message string"
// duck-type (flagged as a weak boundary parse, pulsar TS-AD-04): the old
// check passed for ANY thrown value shaped like `{ message: string }` —
// a plain Error, a defect, an unrelated exception — whether or not it
// actually came from either SDK's declared taxonomy.
export type SdkError = AppError | QuasarError;

export const isSdkError = (error: unknown): error is SdkError =>
  error instanceof ApiRequestError ||
  error instanceof ApiResponseError ||
  error instanceof ApiDecodeError ||
  error instanceof ConfigurationError ||
  error instanceof MissingApiKeyError ||
  error instanceof CommandInputError ||
  error instanceof JsonInputError ||
  error instanceof QuasarConfigError ||
  error instanceof QuasarTransportError ||
  error instanceof QuasarServerError ||
  error instanceof QuasarDecodeError;

export const describeSdkError = (error: unknown): string => {
  // A real member of one of the two SDKs' typed error unions. Every class
  // above carries (or Schema.TaggedError auto-derives, for the couple that
  // declare no `message` field of their own, e.g. MissingApiKeyError) a
  // usable `.message` string.
  if (isSdkError(error)) return error.message;
  // Not a member of either taxonomy — sdk-runtime.ts's runSdkGuarded also
  // routes SdkRuntime's OWN layer-build failures and genuine defects
  // through this function (wrapped by Effect in a FiberFailure, itself an
  // Error subclass), and test fixtures/other call sites reasonably pass a
  // plain Error too. `instanceof Error` is a real type check (the
  // prototype chain), not the shape-sniffing this function used to do — it
  // still only recognizes an actual Error, not any arbitrary
  // `{ message: string }`-shaped value.
  if (error instanceof Error) return error.message;
  return "SDK request failed";
};
