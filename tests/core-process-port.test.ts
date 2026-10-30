import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CoreCallError, inProcessCore } from "../src/main/core-process/client";
import { coreOps, type CoreOp, type CoreOpBody } from "../src/main/core-process/ops";
import { portCore, serveCore, type CorePort } from "../src/main/core-process/port";
import { HostCallError, hostOps, inProcessHost, type HostOp } from "../src/main/core-process/host-ops";

// One operation group, registered as a group under ops/ registers its own.
class Counter extends Context.Service<Counter, { readonly add: (n: number) => Effect.Effect<number> }>()("test/Counter") {}
class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

declare module "../src/main/core-process/ops" {
  interface CoreOps {
    "test.add": CoreOp<{ readonly n: number }, { readonly total: number }>;
    "test.refuse": CoreOp<{ readonly why: string }, never>;
    "test.uncloneable": CoreOp<Record<string, never>, { readonly total: number }>;
  }
}

declare module "../src/main/core-process/host-ops" {
  interface HostOps {
    "test.shot": HostOp<{ readonly scale: number }, { readonly bytes: ReadonlyArray<number> }>;
    "test.hostRefuse": HostOp<Record<string, never>, never>;
  }
}

coreOps({
  // This file tests the port, so its Counter stands in for a core service:
  // the registry's core-services constraint (ops.ts) is waived here on purpose.
  "test.add": (({ n }: { readonly n: number }) =>
    Effect.flatMap(Counter, (counter) => counter.add(n)).pipe(Effect.map((total) => ({ total })))) as unknown as CoreOpBody<"test.add">,
  "test.refuse": ({ why }) => Effect.fail(new Refused({ message: why })),
  // A body whose answer cannot cross a port, which its type does not admit.
  "test.uncloneable": () => Effect.succeed({ total: 1, read: () => 1 } as { readonly total: number }),
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

  it("an answer that cannot cross the port fails its call instead of leaving it waiting", async () => {
    const runtime = runtimeWith();
    const { port1, port2 } = new MessageChannel();
    opened.push(() => {
      port1.close();
      void runtime.dispose();
    });
    serveCore(portOf(port2), runtime);
    const core = portCore(portOf(port1));
    await expect(core.call("test.uncloneable", {})).rejects.toMatchObject({ tag: "CoreAnswerNotCloneable" });
    await expect(core.call("test.add", { n: 2 })).resolves.toEqual({ total: 2 });
    await expect(core.call("test.add", { n: 1, read: () => 1 } as never)).rejects.toMatchObject({ tag: "CoreInputNotCloneable" });
  });

  it("an uncloneable host input or push fails or drops, and never throws into the core", async () => {
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
    await expect(served.host.call("test.shot", { scale: 1, read: () => 1 } as never)).rejects.toMatchObject({ tag: "HostInputNotCloneable" });
    expect(() => served.push("test.changed", { read: () => 1 })).not.toThrow();
    served.push("test.changed", { total: 1 });
    await expect(core.call("test.add", { n: 1 })).resolves.toEqual({ total: 1 });
    expect(pushed).toEqual([{ total: 1 }]);
  });

  it("a stopped core rejects every call in flight", async () => {
    const { port1 } = new MessageChannel();
    opened.push(() => port1.close());
    const core = portCore(portOf(port1));
    const call = core.call("test.add", { n: 1 });
    core.fail("the core process exited");
    await expect(call).rejects.toMatchObject({ tag: "CoreStopped" });
  });

  describe("host operations, the core asking main", () => {
    const registered: Array<() => void> = [];
    afterEach(() => {
      for (const remove of registered.splice(0)) remove();
    });
    const register = () =>
      registered.push(hostOps({
        "test.shot": async ({ scale }) => ({ bytes: [1, 2, 3].map((n) => n * scale) }),
        "test.hostRefuse": async () => {
          throw Object.assign(new Error("no window"), { _tag: "NoWindow" });
        },
      }));

    it("in process: main's body answers, and a failure keeps its tag", async () => {
      register();
      expect(await inProcessHost.call("test.shot", { scale: 2 })).toEqual({ bytes: [2, 4, 6] });
      const refused = await inProcessHost.call("test.hostRefuse", {}).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(HostCallError);
      expect(refused).toMatchObject({ operation: "test.hostRefuse", tag: "NoWindow", message: "no window" });
      await expect(inProcessHost.call("nope" as never, {} as never)).rejects.toMatchObject({ tag: "UnknownHostOp" });
    });

    it("over a port: the core's call reaches main's body and its answer comes back, beside main's own calls", async () => {
      register();
      const runtime = runtimeWith();
      const { port1, port2 } = new MessageChannel();
      opened.push(() => {
        port1.close();
        void runtime.dispose();
      });
      const served = serveCore(portOf(port2), runtime);
      const core = portCore(portOf(port1));
      const [shot, added] = await Promise.all([served.host.call("test.shot", { scale: 3 }), core.call("test.add", { n: 1 })]);
      expect(shot).toEqual({ bytes: [3, 6, 9] });
      expect(added).toEqual({ total: 1 });
      await expect(served.host.call("test.hostRefuse", {})).rejects.toMatchObject({ tag: "NoWindow", message: "no window" });
    });

    it("while the core still starts: its host calls reach main, and main's calls wait for it", async () => {
      register();
      const runtime = runtimeWith();
      const { port1, port2 } = new MessageChannel();
      opened.push(() => {
        port1.close();
        void runtime.dispose();
      });
      let started!: (runner: typeof runtime) => void;
      const served = serveCore(portOf(port2), new Promise<typeof runtime>((resolve) => { started = resolve; }));
      const core = portCore(portOf(port1));
      let answered = false;
      const early = core.call("test.add", { n: 2 }).then((value) => {
        answered = true;
        return value;
      });
      // A boot step asks main before the core can answer anything.
      expect(await served.host.call("test.shot", { scale: 4 })).toEqual({ bytes: [4, 8, 12] });
      expect(answered).toBe(false);
      started(runtime);
      expect(await early).toEqual({ total: 2 });
    });

    it("a stopped main rejects every host call in flight", async () => {
      const runtime = runtimeWith();
      const { port2 } = new MessageChannel();
      opened.push(() => {
        port2.close();
        void runtime.dispose();
      });
      const served = serveCore(portOf(port2), runtime);
      const call = served.host.call("test.shot", { scale: 1 });
      served.failHost("main is gone");
      await expect(call).rejects.toMatchObject({ tag: "HostStopped" });
    });

    it("refuses a host operation registered twice", () => {
      register();
      expect(() => hostOps({ "test.shot": async () => ({ bytes: [] }) })).toThrow(/registered twice/);
    });
  });
});
