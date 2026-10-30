import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CoreCallError, inProcessCore } from "../src/main/core-process/client";
import { coreOps, type CoreOp } from "../src/main/core-process/ops";
import { portCore, serveCore, type CorePort } from "../src/main/core-process/port";

// One operation group, registered as a group under ops/ registers its own.
class Counter extends Context.Service<Counter, { readonly add: (n: number) => Effect.Effect<number> }>()("test/Counter") {}
class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

declare module "../src/main/core-process/ops" {
  interface CoreOps {
    "test.add": CoreOp<{ readonly n: number }, { readonly total: number }>;
    "test.refuse": CoreOp<{ readonly why: string }, never>;
  }
}

coreOps({
  "test.add": ({ n }) => Effect.flatMap(Counter, (counter) => counter.add(n)).pipe(Effect.map((total) => ({ total }))),
  "test.refuse": ({ why }) => Effect.fail(new Refused({ message: why })),
});

const runtimeWith = () => {
  let total = 0;
  return ManagedRuntime.make(Layer.succeed(Counter, { add: (n) => Effect.sync(() => (total += n)) }));
};

const portOf = (port: MessagePort): CorePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: Parameters<typeof handler>[0]) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const opened: Array<() => void> = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

describe("core operations", () => {
  it("in process: answers, and a failure keeps its tag", async () => {
    const runtime = runtimeWith();
    opened.push(() => void runtime.dispose());
    const core = inProcessCore(runtime);
    expect(await core.call("test.add", { n: 2 })).toEqual({ total: 2 });
    expect(await core.call("test.add", { n: 3 })).toEqual({ total: 5 });
    const refused = await core.call("test.refuse", { why: "not yours" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CoreCallError);
    expect(refused).toMatchObject({ operation: "test.refuse", tag: "Refused", message: "not yours" });
  });

  it("over a port: the same answers and failures, and pushes arrive in order after the answer", async () => {
    const runtime = runtimeWith();
    const { port1, port2 } = new MessageChannel();
    opened.push(() => {
      port1.close();
      void runtime.dispose();
    });
    const served = serveCore(portOf(port2), runtime);
    const core = portCore(portOf(port1));
    const pushed: Array<unknown> = [];
    core.onPush("test.changed", (payload) => pushed.push(payload));

    const answer = await core.call("test.add", { n: 4 });
    served.push("test.changed", { total: 4 });
    served.push("test.changed", { total: 5 });
    expect(answer).toEqual({ total: 4 });
    await expect(core.call("test.refuse", { why: "no" })).rejects.toMatchObject({ tag: "Refused", message: "no" });
    expect(pushed).toEqual([{ total: 4 }, { total: 5 }]);
    await expect(core.call("nope" as never, {} as never)).rejects.toMatchObject({ tag: "UnknownCoreOp" });
  });

  it("a stopped core rejects every call in flight", async () => {
    const { port1 } = new MessageChannel();
    opened.push(() => port1.close());
    const core = portCore(portOf(port1));
    const call = core.call("test.add", { n: 1 });
    core.fail("the core process exited");
    await expect(call).rejects.toMatchObject({ tag: "CoreStopped" });
  });
});
