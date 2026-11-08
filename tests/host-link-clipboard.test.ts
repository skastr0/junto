/**
 * The clipboard group over the host link (src/contract/host/): the core's
 * typed client and main's one host server on the two ends of a
 * `MessageChannel`, with main's handlers over a fake system clipboard. And a
 * windowless core, whose host calls fail at once, naming what they asked.
 */
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClipboardHost } from "../src/contract/host/clipboard";
import { HostClientsNoWindow } from "../src/core/host-clients";
import { servedHost } from "./support/host-link";

let scope: Scope.Closeable;
let close: () => void = () => undefined;

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
});

afterEach(async () => {
  close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const fakeClipboard = () => {
  const state = { text: "", formats: ["text/plain"] as ReadonlyArray<string>, formatReads: 0 };
  return {
    state,
    clipboard: {
      readText: () => state.text,
      writeText: (text: string) => {
        state.text = text;
      },
      clear: () => {
        state.text = "";
      },
      availableFormats: () => {
        state.formatReads += 1;
        return state.formats;
      },
    },
  };
};

describe("the clipboard group over the host link", () => {
  it("writes, clears only while the clipboard still holds the text, and reads formats alone", async () => {
    const { state, clipboard } = fakeClipboard();
    const host = await servedHost(scope, clipboard);
    close = host.close;
    const core = await host.core();

    await Effect.runPromise(core.clipboard.ClipboardWrite({ text: "junto://pair/1" }));
    expect(state.text).toBe("junto://pair/1");

    state.text = "something the operator copied since";
    await Effect.runPromise(core.clipboard.ClipboardClearIf({ text: "junto://pair/1" }));
    expect(state.text).toBe("something the operator copied since");

    state.text = "junto://pair/1";
    await Effect.runPromise(core.clipboard.ClipboardClearIf({ text: "junto://pair/1" }));
    expect(state.text).toBe("");

    expect(await Effect.runPromise(core.clipboard.ClipboardSafeForGrok())).toBe(true);
    state.formats = ["image/png", "text/plain"];
    expect(await Effect.runPromise(core.clipboard.ClipboardSafeForGrok())).toBe(false);
    expect(state.formatReads).toBe(2);
  });

  it("answers a core that started again, on the same server", async () => {
    const { state, clipboard } = fakeClipboard();
    const host = await servedHost(scope, clipboard);
    close = host.close;
    const first = await host.core();
    await Effect.runPromise(first.clipboard.ClipboardWrite({ text: "first" }));
    first.peer.leave();

    const next = await host.core();
    await Effect.runPromise(next.clipboard.ClipboardWrite({ text: "next" }));
    expect(state.text).toBe("next");
  });

  it("fails a windowless core's call at once, with the client's error naming the call", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ClipboardHost, (clipboard) => clipboard.ClipboardWrite({ text: "x" })).pipe(
        Effect.provide(HostClientsNoWindow),
        Effect.scoped,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.findErrorOption(exit);
    expect(error._tag === "Some" && error.value._tag).toBe("RpcClientError");
    expect(error._tag === "Some" && error.value.message).toContain("ClipboardWrite needs the Junto app");
  });
});
