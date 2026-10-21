/**
 * A thread post from the window names no author: main posts it as the
 * operator. A post that carries an `actor`, or any other field, is refused
 * at decode, before any port is reached, so the renderer can never pick who
 * wrote it.
 */
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ARTIFACTS_ENABLED, TASKS_ENABLED, productResourceKindEnabled } from "../src/shared/features";
import { asNodeId } from "../src/shared/model";
import { RESOURCE_IPC_CHANNELS, ThreadPostInput, type ThreadResourceSubject } from "../src/shared/resource-ipc";
import { ItemId, OpId } from "../src/shared/work-ids";
import { registerResourceIpc, type ResourceIpcPorts } from "../src/main/junto/work/resource-ipc";

const OP = OpId.make("01M5FA00000000000000000001");
const SEAT_ACTOR = { kind: "seat", seatId: `seat_${"b".repeat(64)}`, nodeId: "S" };
const subjects: ReadonlyArray<ThreadResourceSubject> = [
  { kind: "task", nodeId: asNodeId("T"), taskId: ItemId.make("01M5F9000000000000000000T1") },
  { kind: "artifact", nodeId: asNodeId("A"), artifactId: ItemId.make("01M5F9000000000000000000A1") },
];

/** Every way a post could smuggle its author: in the draft, beside it, or on the subject. */
const smuggled = (subject: ThreadResourceSubject) => [
  { canvasName: "factory", subject, post: { opId: OP, text: "hi", actor: SEAT_ACTOR } },
  { canvasName: "factory", subject, post: { opId: OP, text: "hi" }, actor: SEAT_ACTOR },
  { canvasName: "factory", subject: { ...subject, actor: SEAT_ACTOR }, post: { opId: OP, text: "hi" } },
];

describe("a thread post's author", () => {
  it("is not a field the post schema takes, whatever the decode options", () => {
    for (const subject of subjects) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(ThreadPostInput)({ canvasName: "factory", subject, post: { opId: OP, text: "hi" } }))).toBe(true);
      for (const input of smuggled(subject)) {
        expect(Result.isFailure(Schema.decodeUnknownResult(ThreadPostInput)(input)), JSON.stringify(input)).toBe(true);
        expect(Result.isFailure(Schema.decodeUnknownResult(ThreadPostInput, { onExcessProperty: "ignore" })(input)), JSON.stringify(input)).toBe(true);
      }
    }
  });

  it("is refused at the channel before any port is reached", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const reached: string[] = [];
    const port = (name: string) => () => {
      reached.push(name);
      return Effect.die(`${name} reached`);
    };
    const ports = {
      topology: port("topology"),
      mailbox: port("mailbox"),
      queue: port("queue"),
      tasks: { list: port("list"), submit: port("submit"), find: port("find"), comment: port("task comment") },
      artifacts: { list: port("list"), head: port("head"), body: port("body"), history: port("history"), submit: port("submit"), pull: port("pull"), comment: port("artifact comment") },
    } as unknown as ResourceIpcPorts;
    const stop = registerResourceIpc(
      { handle: (channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(channel, listener) } as never,
      (effect) => Effect.runPromise(effect as Effect.Effect<never>),
      ports,
      () => undefined,
      { task: true, artifact: true },
      { task: (operation) => operation(), artifact: (operation) => operation(), thread: (operation) => operation() },
    );
    try {
      const post = handlers.get(RESOURCE_IPC_CHANNELS.thread.post);
      // A build with neither product registers no thread channel at all.
      expect(post === undefined).toBe(!TASKS_ENABLED && !ARTIFACTS_ENABLED);
      if (post === undefined) return;
      for (const subject of subjects.filter((one) => productResourceKindEnabled(one.kind))) {
        for (const input of smuggled(subject)) {
          await expect(post(undefined, input), JSON.stringify(input)).rejects.toThrow();
        }
      }
      expect(reached).toEqual([]);
    } finally {
      stop();
    }
  });
});
