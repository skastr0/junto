/**
 * Why a canvas command failed, as a tag the window can decide on.
 *
 * A failure of the model crosses the core (`ModelFailed.kind`) and main's IPC
 * (which can carry only a message) on its way to the window. The kind rides in
 * the message as a marker main puts there and the window takes off again, so
 * the window decides from the kind, never from the words:
 * - `refused`: the model said no (a rule, or a command that did not decode).
 *   A retry gets the same answer.
 * - `missing`: what the command names is not there.
 * - `storage`: the model could not read or write. A retry can fix it.
 * - `transport`: the core did not answer (it left, the socket closed). A retry
 *   can fix it once it is back.
 * A failure with no marker is of no known kind, and is not offered a retry.
 */
export const MODEL_FAILURE_KINDS = ["refused", "missing", "storage", "transport"] as const;
export type ModelFailureKind = (typeof MODEL_FAILURE_KINDS)[number];

const isKind = (value: string): value is ModelFailureKind => (MODEL_FAILURE_KINDS as ReadonlyArray<string>).includes(value);

const MARKER = /\[model:([a-z]+)\] ?/;

/** The kind of a failure from the model's tag. Undefined for a tag this does not know. */
export const failureKindOfTag = (tag: string | undefined): ModelFailureKind | undefined => {
  switch (tag) {
    case "ModelRefused":
    case "ParseError":
    case "SchemaError":
      return "refused";
    case "ModelNotFound":
      return "missing";
    case "ModelStorageError":
      return "storage";
    case "RpcClientError":
      return "transport";
    default:
      return undefined;
  }
};

/** The message with its kind marked, for main to throw across IPC. */
export const withFailureKind = (kind: ModelFailureKind, message: string): string => `[model:${kind}] ${message}`;

/** The kind a failure carries, from its marker. */
export const failureKindOf = (error: unknown): ModelFailureKind | undefined => {
  const found = MARKER.exec(error instanceof Error ? error.message : String(error));
  return found?.[1] !== undefined && isKind(found[1]) ? found[1] : undefined;
};

/** The words of a failure, without its marker. */
export const failureWords = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(MARKER, "");

/** Whether trying the same thing again can fix it. */
export const failureCanRetry = (error: unknown): boolean => {
  const kind = failureKindOf(error);
  return kind === "storage" || kind === "transport";
};

/**
 * A failure as the window can tell it apart. Electron carries only a rejected
 * call's message, so the kind (src/shared/model-failure.ts) goes in the message:
 * the core's own answer carries its kind, a core that left is `transport`, and
 * a command that did not decode is `refused`. The window reads the kind, not the words.
 */
export const markFailureKind = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (error) {
    const found = error !== null && typeof error === "object" ? (error as { readonly _tag?: unknown; readonly kind?: unknown; readonly message?: unknown; readonly cause?: unknown }) : undefined;
    // Effect rejects with the failure itself or wraps it: look one level in.
    const failure = found?._tag === undefined && found?.cause !== null && typeof found?.cause === "object" ? (found.cause as typeof found) : found;
    const tag = typeof failure?._tag === "string" ? failure._tag : undefined;
    const kind =
      tag === "ModelFailed" && typeof failure?.kind === "string"
        ? (failure.kind as ModelFailureKind)
        : failureKindOfTag(tag);
    const message = error instanceof Error ? error.message : String(error);
    if (kind === undefined) throw error;
    throw new Error(withFailureKind(kind, message));
  }
};

/**
 * The words of a call that got no answer. A command's is a transport failure
 * (a retry can fix it, so it is marked); any other channel keeps its words.
 */
export const noAnswerWords = (isCommand: boolean, words: string): string => (isCommand ? withFailureKind("transport", words) : words);
