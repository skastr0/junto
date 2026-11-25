import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { markFailureKind as withKind, noAnswerWords, failureCanRetry, failureKindOf, failureKindOfTag, failureWords, withFailureKind } from "../src/shared/model-failure";
import { ModelFailed } from "../src/contract/core/model";
import { offersRetry } from "../src/window/lib/save-retry";

/** What the window gets of a rejected call: Electron keeps only the message, and puts its own words before it. */
const acrossIpc = (error: unknown): Error =>
  new Error(`Error invoking remote method 'model:command': Error: ${error instanceof Error ? error.message : String(error)}`);

const rejected = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("did not reject");
};

describe("a model failure's kind", () => {
  it("is decided from the tag the model gave, and from nothing else", () => {
    expect(failureKindOfTag("ModelRefused")).toBe("refused");
    expect(failureKindOfTag("ModelNotFound")).toBe("missing");
    expect(failureKindOfTag("ModelStorageError")).toBe("storage");
    expect(failureKindOfTag("RpcClientError")).toBe("transport");
    expect(failureKindOfTag("SchemaError")).toBe("refused");
    expect(failureKindOfTag(undefined)).toBeUndefined();
    expect(failureKindOfTag("Surprise")).toBeUndefined();
  });

  it("rides the message through IPC and comes off it again", () => {
    const error = acrossIpc(new Error(withFailureKind("storage", "cannot write the canvas")));
    expect(failureKindOf(error)).toBe("storage");
    expect(failureWords(error)).toBe("Error invoking remote method 'model:command': Error: cannot write the canvas");
  });

  it("offers a retry for storage and transport failures, not for a refusal or an unmarked one", () => {
    const marked = (kind: Parameters<typeof withFailureKind>[0]) => acrossIpc(new Error(withFailureKind(kind, "words")));
    expect(failureCanRetry(marked("storage"))).toBe(true);
    expect(failureCanRetry(marked("transport"))).toBe(true);
    expect(failureCanRetry(marked("refused"))).toBe(false);
    expect(failureCanRetry(marked("missing"))).toBe(false);
    // The old words are not a reason any more.
    expect(failureCanRetry(new Error("cannot write the canvas"))).toBe(false);
    expect(failureCanRetry(new Error("write-canvas failed"))).toBe(false);
  });

  it("is offered for the banner's own text only", () => {
    expect(offersRetry("canvas \"a\" did not take that change: x", "canvas \"a\" did not take that change: x")).toBe(true);
    expect(offersRetry("another error", "canvas \"a\" did not take that change: x")).toBe(false);
    expect(offersRetry("", "")).toBe(false);
  });
});

describe("a call that got no answer", () => {
  it("is a transport failure a retry can fix when it was a command, and keeps its words otherwise", () => {
    const command = new Error(noAnswerWords(true, "Main did not answer (model:command). Try restarting the app."));
    expect(failureKindOf(command)).toBe("transport");
    expect(failureCanRetry(command)).toBe(true);
    expect(failureWords(command)).toBe("Main did not answer (model:command). Try restarting the app.");
    const other = new Error(noAnswerWords(false, "Main did not answer (doctor). Try restarting the app."));
    expect(failureKindOf(other)).toBeUndefined();
    expect(failureWords(other)).toBe("Main did not answer (doctor). Try restarting the app.");
  });
});

describe("main's edge marks a command's failure with its kind", () => {
  it("carries the core's own kind for a refusal and for a storage failure", async () => {
    const refused = await rejected(() => withKind(() => Effect.runPromise(Effect.fail(new ModelFailed({ message: "Choose another name.", kind: "refused" })))));
    expect(failureKindOf(refused)).toBe("refused");
    expect(failureWords(refused)).toContain("Choose another name.");
    const storage = await rejected(() => withKind(() => Effect.runPromise(Effect.fail(new ModelFailed({ message: "disk full", kind: "storage" })))));
    expect(failureKindOf(storage)).toBe("storage");
  });

  it("marks a core that did not answer as transport", async () => {
    const left = await rejected(() => withKind(() => Effect.runPromise(Effect.fail({ _tag: "RpcClientError", message: "the core left" }))));
    expect(failureKindOf(left)).toBe("transport");
  });

  it("marks a command that does not decode as refused, and leaves an unknown failure as it was", async () => {
    const bad = await rejected(() => withKind(() => Effect.runPromise(Schema.decodeUnknownEffect(Command)({ _tag: "Nope" }))));
    expect(failureKindOf(bad)).toBe("refused");
    const unknown = new Error("who knows");
    expect(await rejected(() => withKind(() => Promise.reject(unknown)))).toBe(unknown);
  });
});
