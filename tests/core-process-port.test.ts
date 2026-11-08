import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { portPushes, type CorePort } from "../src/contract/core/port";
import { serveCore } from "../src/core/serve";

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

const connected = () => {
  const { port1, port2 } = new MessageChannel();
  opened.push(() => {
    port1.close();
    port2.close();
  });
  return { served: serveCore(portOf(port2)), main: portPushes(portOf(port1)) };
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the core's pushes over the port", () => {
  it("arrive on their channel, in the order they were published", async () => {
    const { served, main } = connected();
    const heard: Array<unknown> = [];
    main.onPush("test.changed", (payload) => heard.push(payload));
    served.push("test.changed", { n: 1 });
    served.push("test.other", { n: 99 });
    served.push("test.changed", { n: 2 });
    await settled();
    expect(heard).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reach every listener of a channel until it is removed", async () => {
    const { served, main } = connected();
    const first: Array<unknown> = [];
    const second: Array<unknown> = [];
    const stopFirst = main.onPush("test.changed", (payload) => first.push(payload));
    main.onPush("test.changed", (payload) => second.push(payload));
    served.push("test.changed", 1);
    await settled();
    stopFirst();
    served.push("test.changed", 2);
    await settled();
    expect(first).toEqual([1]);
    expect(second).toEqual([1, 2]);
  });

  it("drop a payload that cannot cross, and never throw into the publisher", async () => {
    const { served, main } = connected();
    const heard: Array<unknown> = [];
    main.onPush("test.changed", (payload) => heard.push(payload));
    expect(() => served.push("test.changed", { read: () => 1 })).not.toThrow();
    served.push("test.changed", { total: 1 });
    await settled();
    expect(heard).toEqual([{ total: 1 }]);
  });
});
