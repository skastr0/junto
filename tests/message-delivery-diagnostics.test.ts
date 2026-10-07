import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canvasOf, note, seat } from "./support/model-nodes";
import type { Message } from "../src/shared/work-model";
import { MessageDeliveryService, type MessageDeliveryStore, type MessageDeliveryTransport } from "../src/main/junto/work/message-delivery";

const canvas = "cold";
const nodeId = "never-started";
const binding = "cold-binding";
const messageId = "pending-mail";
const message: Message = { messageId, role: "user", parts: [{ kind: "text", text: "private body" }] };
const model = canvasOf([seat(nodeId, { agentKey: "local:cold", bindingId: binding as never })], [], canvas);
let service: MessageDeliveryService;
let errors: ReturnType<typeof vi.spyOn>;
let information: ReturnType<typeof vi.spyOn>;
const logs = () => [...errors.mock.calls, ...information.mock.calls].map(args => args.map(String).join(" ")).join("\n");
const configure = (store: Partial<MessageDeliveryStore> = {}, transport: Partial<MessageDeliveryTransport> = {}) => {
  const wake = vi.fn(async () => true);
  const write = vi.fn(async () => "written" as const);
  const stamp = vi.fn(async () => true);
  service.configure({
    store: {
      listCanvasNames: async () => [canvas], readModel: async () => model,
      readMessage: async () => message, listMail: async () => [message], acceptMessageDelivery: stamp,
      ...store,
    },
    transport: { seatLive: () => false, wakeSeat: wake, writeMail: write, ...transport },
  });
  return { wake, write, stamp };
};
const attempt = () => service.deliver(canvas, nodeId, messageId);
const context = (reason: string) => {
  expect(logs()).toContain("[delivery]");
  expect(logs()).toContain(canvas); expect(logs()).toContain(nodeId); expect(logs()).toContain(messageId);
  expect(logs()).toContain(reason); expect(logs()).not.toContain("private body");
};
beforeEach(() => {
  service = new MessageDeliveryService();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  information = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { service.suspend(); errors.mockRestore(); information.mockRestore(); });

it("names an unconfigured attempt instead of silently waiting", async () => {
  expect(await attempt()).toBe("waiting"); context("not configured");
});
it.each([
  ["model unavailable", { readModel: async (): Promise<undefined> => undefined }],
  ["node is not on the canvas", { readModel: async () => canvasOf([], [], canvas) }],
  ["message is not in the mailbox", { readMessage: async () => undefined }],
  ["node holds no agent seat", { readModel: async () => canvasOf([note(nodeId)], [], canvas) }],
] as const)("names %s and does not wake or stamp", async (reason, store) => {
  const f = configure(store);
  expect(await attempt()).toBe("waiting"); context(reason);
  expect(f.wake).not.toHaveBeenCalled(); expect(f.stamp).not.toHaveBeenCalled();
});
it("names a failed authority read with the error", async () => {
  configure({ readModel: async () => { throw new Error("model query refused"); } });
  expect(await attempt()).toBe("waiting"); context("model query refused");
});
it("names no-wake mail without starting the seat", async () => {
  const f = configure(); service.holdWake(messageId);
  expect(await attempt()).toBe("waiting"); context("no-wake"); expect(f.wake).not.toHaveBeenCalled();
});
it("logs a rejected wake with message identity and does not write a receipt", async () => {
  const f = configure({}, { wakeSeat: async () => { throw new Error("occupy failed"); } });
  expect(await attempt()).toBe("waiting");
  await Promise.resolve(); context("occupy failed"); expect(f.stamp).not.toHaveBeenCalled();
});
it("names a wake already in flight for a never-started seat", async () => {
  let finish!: (started: boolean) => void;
  const wake = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  configure({}, { wakeSeat: wake });
  expect(await attempt()).toBe("waiting");
  expect(await service.deliver(canvas, nodeId, "second-mail")).toBe("waiting");
  expect(wake).toHaveBeenCalledTimes(1); context("wake already in flight"); finish(true);
});
it("names generation invalidation during the model read", async () => {
  let finish!: (value: typeof model) => void;
  configure({ readModel: () => new Promise(resolve => { finish = resolve; }) });
  const pending = attempt(); service.suspend(); finish(model);
  expect(await pending).toBe("waiting"); context("generation ended");
});
it("names a refused durable receipt after the write", async () => {
  const f = configure({ acceptMessageDelivery: async () => false }, { seatLive: () => true });
  expect(await attempt()).toBe("delivered"); context("receipt refused"); expect(f.write).toHaveBeenCalledTimes(1);
  await attempt(); expect(f.write).toHaveBeenCalledTimes(1);
});
it("a never-started seat wakes, then writes and stamps on readiness without another wake", async () => {
  let live = false;
  const f = configure({}, { seatLive: () => live });
  expect(await attempt()).toBe("waiting"); expect(f.wake).toHaveBeenCalledWith(binding, canvas, nodeId);
  expect(f.write).not.toHaveBeenCalled(); expect(f.stamp).not.toHaveBeenCalled();
  live = true;
  expect(await attempt()).toBe("delivered"); expect(f.write).toHaveBeenCalledTimes(1); expect(f.stamp).toHaveBeenCalledTimes(1);
  expect(f.wake).toHaveBeenCalledTimes(1);
});
