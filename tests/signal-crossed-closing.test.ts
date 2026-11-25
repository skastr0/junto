/**
 * Race C (step 77): a signal withdrawn on its seat's machine while it is
 * answered on the machine that edits the canvas. Both closings are kept, the
 * second beside the first, and the answer that reaches a seat after its
 * withdrawal is held: never typed, never stamped delivered.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/core/state/engine";
import { AgentSignalRepository, AgentSignalRepositoryLive, type TakenAgentSignal } from "../src/core/signals/repository";
import { onAgentSignalChanged } from "../src/core/signals/changes";
import { MessageDeliveryService, type MessageDeliveryStore } from "../src/core/work/message-delivery";
import { newestWakingMail } from "../src/core/boat/keeper";
import { ANSWER_HELD_WORDS, answerHeld } from "../src/shared/signal-answer-held";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import type { Message } from "../src/shared/work-model";
import { mailExtensionMetadata, type MailExtension } from "../src/shared/crew";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import { canvasOf, seat } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

const canvasName = "crew";
const nodeId = "agent-b";
const otherNodeId = "agent-c";
const bindingId = "bind-b";
const SIGNAL = "01M8C0000000000000000000S1";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<AgentSignalRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-crossed-"));
  runtime = ManagedRuntime.make(AgentSignalRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, AgentSignalRepository>) => runtime.runPromise(effect);

/** The raise as the seat's machine states it. */
const raised: TakenAgentSignal = {
  canvasName,
  nodeId,
  signalId: SIGNAL,
  kind: "escalate",
  text: "which database",
  createdAt: 1_000,
  raises: true,
};
const withdrawal = (closedAt: number): TakenAgentSignal => ({ ...raised, closing: { state: "withdrawn", closedAt } });
const answer = (closedAt: number, text = "use sqlite"): TakenAgentSignal => ({
  ...raised,
  raises: false,
  closing: { state: "answered", closedAt, response: { text, at: closedAt } },
});

/** Every signal the store announced while `body` ran. */
const announced = async <A>(body: () => Promise<A>): Promise<{ readonly value: A; readonly heard: ReadonlyArray<AgentSignal> }> => {
  const heard: AgentSignal[] = [];
  const stop = onAgentSignalChanged((signal) => heard.push(signal));
  try {
    const value = await body();
    return { value, heard };
  } finally {
    stop();
  }
};

describe("both closings are kept, on the editing machine", () => {
  it("an answered signal the seat withdrew after keeps its answer and gains withdrawnAt", async () => {
    const answered = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.take(raised);
      return yield* store.answer(SIGNAL, "use sqlite");
    }));
    const { value: taken, heard } = await announced(() => run(Effect.gen(function* () {
      return yield* (yield* AgentSignalRepository).take(withdrawal(5_000));
    })));
    expect(taken).toMatchObject({ state: "answered", withdrawnAt: 5_000, closedAt: answered.closedAt, response: { text: "use sqlite" } });
    // The window hears the change; it is still an answered signal, never a fresh answer.
    expect(heard.map((signal) => [signal.state, signal.withdrawnAt])).toEqual([["answered", 5_000]]);
    // Told again, nothing moves.
    const again = await run(Effect.gen(function* () {
      return yield* (yield* AgentSignalRepository).take(withdrawal(6_000));
    }));
    expect(again).toBeUndefined();
    const held = await run(Effect.gen(function* () {
      return yield* (yield* AgentSignalRepository).get(SIGNAL);
    }));
    expect(held.withdrawnAt).toBe(5_000);
  });

  it("withdrawnAt is the seat machine's claim, kept between the raise and its arrival here", async () => {
    const late = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.take(raised);
      yield* store.answer(SIGNAL, "use sqlite");
      return yield* store.take(withdrawal(Date.now() + 365 * 24 * 3_600_000));
    }));
    expect(late?.withdrawnAt).toBeLessThanOrEqual(Date.now());
    expect(late?.withdrawnAt).toBeGreaterThan(raised.createdAt);
  });

  it("a withdrawal stated before the raise is kept at the raise", async () => {
    const early = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.take(raised);
      yield* store.answer(SIGNAL, "use sqlite");
      return yield* store.take(withdrawal(0));
    }));
    expect(early?.withdrawnAt).toBe(raised.createdAt);
  });

  it("a withdrawal that lands first closes it withdrawn, and no answer is kept beside it", async () => {
    const held = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.take(raised);
      yield* store.take(withdrawal(5_000));
      const refused = yield* Effect.flip(store.answer(SIGNAL, "too late"));
      return { refused, signal: yield* store.get(SIGNAL) };
    }));
    expect(held.refused._tag).toBe("AgentSignalNotFound");
    expect(held.signal.state).toBe("withdrawn");
    expect(held.signal.response).toBeUndefined();
    expect(held.signal.withdrawnAt).toBeUndefined();
  });

  it("only the seat's own machine marks the withdrawal: an editor's closing never sets withdrawnAt", async () => {
    const signal = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.take(raised);
      yield* store.answer(SIGNAL, "use sqlite");
      yield* store.take({ ...withdrawal(5_000), raises: false });
      return yield* store.get(SIGNAL);
    }));
    expect(signal.withdrawnAt).toBeUndefined();
  });

  it("a dismissed signal the seat withdrew stays dismissed, with nothing beside it", async () => {
    const signal = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.take(raised);
      yield* store.dismiss(SIGNAL);
      expect(yield* store.take(withdrawal(5_000))).toBeUndefined();
      return yield* store.get(SIGNAL);
    }));
    expect(signal.state).toBe("dismissed");
    expect(signal.withdrawnAt).toBeUndefined();
  });
});

describe("both closings are kept, on the seat's machine", () => {
  const seatOwn = { canvasName, nodeId };

  it("a withdrawn signal keeps the late answer's words and time, and stays withdrawn", async () => {
    const withdrawn = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.raise({ ...seatOwn, signalId: SIGNAL, kind: "escalate", text: "which database" });
      const [signal] = yield* store.withdraw(seatOwn, SIGNAL);
      return signal!;
    }));
    const { value: taken, heard } = await announced(() => run(Effect.gen(function* () {
      return yield* (yield* AgentSignalRepository).take(answer(7_000));
    })));
    expect(taken).toMatchObject({ state: "withdrawn", closedAt: withdrawn.closedAt, response: { text: "use sqlite", at: 7_000 } });
    expect(taken?.withdrawnAt).toBeUndefined();
    // Heard as a withdrawn signal: nothing that acts on an answer reads it as one.
    expect(heard.map((signal) => signal.state)).toEqual(["withdrawn"]);
    const listed = await run(Effect.gen(function* () {
      return yield* (yield* AgentSignalRepository).listSeatAnswered(seatOwn);
    }));
    expect(listed).toEqual([]);
    // Told again, the first answer kept stays.
    const again = await run(Effect.gen(function* () {
      return yield* (yield* AgentSignalRepository).take(answer(8_000, "use postgres"));
    }));
    expect(again).toBeUndefined();
  });

  it("an answer that lands first closes it answered, and the seat can no longer withdraw it", async () => {
    const after = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.raise({ ...seatOwn, signalId: SIGNAL, kind: "escalate", text: "which database" });
      yield* store.take(answer(7_000));
      const refused = yield* Effect.flip(store.withdraw(seatOwn, SIGNAL));
      return { refused, signal: yield* store.get(SIGNAL) };
    }));
    expect(after.refused._tag).toBe("AgentSignalNotFound");
    expect(after.signal).toMatchObject({ state: "answered", response: { text: "use sqlite" } });
  });

  it("only the editing machine's answer is kept: a raise stated again with an answer moves nothing", async () => {
    const signal = await run(Effect.gen(function* () {
      const store = yield* AgentSignalRepository;
      yield* store.raise({ ...seatOwn, signalId: SIGNAL, kind: "escalate", text: "which database" });
      yield* store.withdraw(seatOwn, SIGNAL);
      yield* store.take({ ...answer(7_000), raises: true });
      return yield* store.get(SIGNAL);
    }));
    expect(signal.response).toBeUndefined();
  });
});

const OTHER_SENDER = `seat_${"d".repeat(64)}` as MailExtension["fromSeat"];

/** The operator's answer mail, as the seat's mailbox holds it. */
const answerMail = (messageId: string, signalId: string, from: MailExtension["fromSeat"] = OPERATOR_SEAT_ID): Message => ({
  messageId,
  role: "user",
  parts: [{ kind: "text", text: "use sqlite" }],
  metadata: {
    factoryMail: true,
    agentSignalId: signalId,
    ...mailExtensionMetadata({
      mailKind: "prompt",
      fromSeat: from,
      senderNodeId: "operator",
      senderName: "operator",
      senderGeneration: "operator",
      senderHarness: "unknown",
    }),
  },
});

const signalOf = (state: AgentSignal["state"], more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId: SIGNAL,
  canvasName,
  nodeId,
  kind: "escalate",
  text: "which database",
  createdAt: 1_000,
  state,
  ...more,
});

describe("answerHeld, the one rule", () => {
  const mailbox = { canvasName, nodeId };

  it("holds the operator's answer to the mailbox seat's own withdrawn signal, before any receipt", () => {
    expect(answerHeld(mailbox, answerMail("01A", SIGNAL), signalOf("withdrawn"))).toBe(true);
  });

  it("reads the editing machine's face the same: answered, with the seat's withdrawal beside it", () => {
    expect(answerHeld(mailbox, answerMail("01A", SIGNAL), signalOf("answered", { withdrawnAt: 5_000 }))).toBe(true);
    expect(answerHeld(mailbox, answerMail("01A", SIGNAL), signalOf("answered"))).toBe(false);
    expect(answerHeld(mailbox, answerMail("01A", SIGNAL), signalOf("dismissed"))).toBe(false);
  });

  it("holds nothing else", () => {
    const mail = answerMail("01A", SIGNAL);
    expect(answerHeld(mailbox, mail, undefined), "an id this machine does not hold").toBe(false);
    expect(answerHeld(mailbox, mail, signalOf("open")), "still open").toBe(false);
    expect(answerHeld(mailbox, mail, signalOf("answered")), "answered").toBe(false);
    expect(answerHeld(mailbox, mail, signalOf("withdrawn", { nodeId: otherNodeId })), "another seat's").toBe(false);
    expect(answerHeld(mailbox, mail, signalOf("withdrawn", { canvasName: "elsewhere" })), "another canvas's").toBe(false);
    expect(
      answerHeld(mailbox, mail, signalOf("withdrawn", { source: { kind: "automation", automationId: "a1", nodeId } } as Partial<AgentSignal>)),
      "an automation's",
    ).toBe(false);
    expect(answerHeld(mailbox, answerMail("01A", "01M8C0000000000000000000S2"), signalOf("withdrawn")), "names another signal").toBe(false);
    expect(answerHeld(mailbox, answerMail("01A", SIGNAL, OTHER_SENDER), signalOf("withdrawn")), "a seat's mail, not the operator's").toBe(false);
    const delivered = { ...mail, metadata: { ...mail.metadata, deliveredAt: 9 } };
    expect(answerHeld(mailbox, delivered, signalOf("withdrawn")), "already delivered").toBe(false);
  });

  it("says so in fixed words", () => {
    expect(ANSWER_HELD_WORDS).toBe("withdrawn before the answer arrived");
  });
});

describe("delivery holds a late answer", () => {
  const crew = canvasOf(
    [seat(nodeId, { width: 100, height: 80, label: "Claude Code", agentKey: "local:claude", bindingId: bindingId as never })],
    [],
    "crew",
  );

  const rig = (signals: Map<string, AgentSignal>) => {
    const messages: Message[] = [];
    const writes: string[] = [];
    const stamped: string[] = [];
    const reads: string[] = [];
    const store: MessageDeliveryStore = {
      listCanvasNames: async () => [canvasName],
      readModel: async () => crew,
      readMessage: async (_canvas, _node, messageId) => {
        reads.push(messageId);
        return messages.find((message) => message.messageId === messageId);
      },
      listMail: async () => messages,
      signalOf: async (signalId) => signals.get(signalId),
      acceptMessageDelivery: async (_canvas, _node, messageId, read) => {
        stamped.push(messageId);
        const index = messages.findIndex((message) => message.messageId === messageId);
        messages[index] = {
          ...messages[index]!,
          metadata: { ...messages[index]!.metadata, deliveredAt: Date.now(), ...(read ? { readAt: Date.now() } : {}) },
        };
        return true;
      },
    };
    const service = new MessageDeliveryService(() => THIS_MACHINE, { quietMs: 10, maxWaitMs: 50 });
    service.configure({
      store,
      transport: {
        seatLive: (id) => id === bindingId,
        writeMail: async (_id, text) => {
          writes.push(text);
          return "written";
        },
      },
    });
    services.push(service);
    return { service, messages, writes, stamped, reads };
  };

  const services: MessageDeliveryService[] = [];
  afterEach(() => {
    for (const service of services.splice(0)) service.suspend();
  });

  it("the withdrawal first: the answer is never typed and never stamped", async () => {
    const seatRig = rig(new Map([[SIGNAL, signalOf("withdrawn")]]));
    seatRig.messages.push(answerMail("01A", SIGNAL));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("waiting");
    expect(seatRig.writes).toEqual([]);
    expect(seatRig.stamped).toEqual([]);
    // Asked again, as a boot scan or a new event for it would: still held.
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("waiting");
    expect(seatRig.writes).toEqual([]);
  });

  it("a held answer is not tried again on each wake: a seat coming live or a resume reads it no more", async () => {
    const seatRig = rig(new Map([[SIGNAL, signalOf("withdrawn")]]));
    seatRig.messages.push(answerMail("01A", SIGNAL));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("waiting");
    const reads = seatRig.reads.length;
    for (let i = 0; i < 5; i += 1) {
      seatRig.service.onSeatLive(bindingId);
      seatRig.service.onResumed(canvasName);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seatRig.reads.length).toBe(reads);
    expect(seatRig.writes).toEqual([]);
  });

  it("the answer first, while the signal is open: it is typed, and the withdrawal after changes nothing", async () => {
    const signals = new Map([[SIGNAL, signalOf("open")]]);
    const seatRig = rig(signals);
    seatRig.messages.push(answerMail("01A", SIGNAL));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("delivered");
    expect(seatRig.writes).toHaveLength(1);
    signals.set(SIGNAL, signalOf("withdrawn"));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("delivered");
    expect(seatRig.writes).toHaveLength(1);
    expect(seatRig.stamped).toEqual(["01A"]);
  });

  it("a mail naming another seat's withdrawn signal is delivered", async () => {
    const seatRig = rig(new Map([[SIGNAL, signalOf("withdrawn", { nodeId: otherNodeId })]]));
    seatRig.messages.push(answerMail("01A", SIGNAL));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("delivered");
    expect(seatRig.writes).toHaveLength(1);
  });

  it("a seat's mail naming the withdrawn signal is delivered: only the operator's answer is held", async () => {
    const seatRig = rig(new Map([[SIGNAL, signalOf("withdrawn")]]));
    seatRig.messages.push(answerMail("01A", SIGNAL, OTHER_SENDER));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("delivered");
    expect(seatRig.writes).toHaveLength(1);
  });

  it("a signal this machine does not hold is ordinary mail", async () => {
    const seatRig = rig(new Map());
    seatRig.messages.push(answerMail("01A", SIGNAL));
    expect(await seatRig.service.deliver(canvasName, nodeId, "01A")).toBe("delivered");
    expect(seatRig.writes).toHaveLength(1);
  });
});

describe("the Boat keeper never wakes a machine for a held answer", () => {
  const mailbox = { canvasName, nodeId };
  const notice = (messageId: string): Message => ({
    messageId,
    role: "user",
    parts: [{ kind: "text", text: "hello" }],
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "notice",
        fromSeat: OTHER_SENDER,
        senderNodeId: otherNodeId,
        senderName: "Claude Code",
        senderGeneration: "ep_c",
        senderHarness: "claude",
      }),
    },
  });

  it("skips an answer the seat withdrew first, on the editing machine's face", () => {
    const crossed = new Map([[SIGNAL, signalOf("answered", { withdrawnAt: 5_000 })]]);
    expect(newestWakingMail(mailbox, [answerMail("01B", SIGNAL)], (id) => crossed.get(id))).toBeUndefined();
    // Older ordinary mail still wakes it.
    expect(newestWakingMail(mailbox, [notice("01A"), answerMail("01B", SIGNAL)], (id) => crossed.get(id))).toBe("01A");
  });

  it("wakes for an answer whose signal no withdrawal crossed, and for one it does not hold", () => {
    const answered = new Map([[SIGNAL, signalOf("answered")]]);
    expect(newestWakingMail(mailbox, [notice("01A"), answerMail("01B", SIGNAL)], (id) => answered.get(id))).toBe("01B");
    expect(newestWakingMail(mailbox, [answerMail("01B", SIGNAL)], () => undefined)).toBe("01B");
  });

  it("never counts mail its seat already has", () => {
    const delivered = { ...notice("01C"), metadata: { ...notice("01C").metadata, deliveredAt: 9 } };
    expect(newestWakingMail(mailbox, [notice("01A"), delivered], () => undefined)).toBe("01A");
  });
});
