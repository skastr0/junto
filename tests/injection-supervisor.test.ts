import { describe, expect, it, vi } from "vitest";
import {
  InjectionSupervisor,
  type ComposerLookup,
  type NoticeWriter,
} from "../src/main/junto/term/injection-supervisor";
import { buildOnboardNudge } from "../src/shared/managed-terminal-injection";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { SeatOnboardingEvent } from "../src/shared/seat-onboarding-status";

const snap = (over: Partial<ObserverGridSnapshot> = {}): ObserverGridSnapshot => ({
  bindingId: "b1",
  epoch: "e1",
  cols: 120,
  rows: 30,
  lines: ["", "❯ "],
  text: "",
  seq: 1n,
  signals: { title: "", osc9: "", modes: { bracketedPaste: false, synchronizedOutput: false, altScreen: false, mouseModes: [] } },
  ...over,
});

const seatEvent = (over: Partial<AgentSeatStateEvent> = {}): AgentSeatStateEvent => ({
  bindingId: "b1",
  epoch: "e1",
  state: "idle",
  reason: "test",
  confidence: "high",
  at: 0,
  ...over,
});

/** Let the session-record callbacks (always async) settle. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/**
 * One seat under supervision. `record` stands in for the per-session marker
 * on disk, keyed by the harness session id the binding is running.
 */
const rig = (writer = vi.fn<NoticeWriter>().mockReturnValue(true)) => {
  const supervisor = new InjectionSupervisor();
  const onboardedSessions = new Set<string>();
  const session = { id: "session-1" as string | undefined };
  const composer = { verdict: "empty" as ReturnType<ComposerLookup> };
  const events: SeatOnboardingEvent[] = [];
  supervisor.setWriter(writer);
  supervisor.setComposerLookup(() => composer.verdict);
  supervisor.setOnboardedRecord({
    load: async () => session.id !== undefined && onboardedSessions.has(session.id),
    save: async () => {
      if (session.id === undefined) return false;
      onboardedSessions.add(session.id);
      return true;
    },
  });
  supervisor.subscribeOnboarding((event) => events.push(event));
  const epoch = { current: "e1" };
  const state = (value: AgentSeatStateEvent["state"]) =>
    supervisor.noteSeatState(seatEvent({ state: value, epoch: epoch.current }));
  /** A fresh generation comes up idle at its own empty composer. */
  const start = async (next = epoch.current) => {
    epoch.current = next;
    state("idle");
    await settled();
  };
  const turn = () => {
    state("working");
    state("idle");
  };
  /** The operator types a message and submits it; the agent answers. */
  const operatorTurn = () => {
    composer.verdict = "draft";
    supervisor.noteUserInput("b1");
    composer.verdict = "empty";
    turn();
  };
  /** Mail is typed into the seat; the agent answers. */
  const mailTurn = () => {
    supervisor.noteMailWritten("b1");
    turn();
  };
  const exit = () => state("gone");
  return { supervisor, writer, composer, session, onboardedSessions, events, start, state, turn, operatorTurn, mailTurn, exit };
};

describe("InjectionSupervisor", () => {
  describe("never before a first real message", () => {
    it("writes nothing to a seat that only started", async () => {
      const { writer, supervisor, start } = rig();
      await start();
      supervisor.onSnapshot(snap());
      expect(writer).not.toHaveBeenCalled();
    });

    it("does not count turns nobody asked for", async () => {
      // A harness that flips working and idle while it boots has not been
      // spoken to: those flips are not turns, however many there are.
      const { writer, start, turn } = rig();
      await start();
      for (let i = 0; i < 6; i += 1) turn();
      expect(writer).not.toHaveBeenCalled();
    });

    it("operator keystrokes with no draft are not a message", async () => {
      // Arrowing through a startup dialog types into the terminal but never
      // puts a draft in the composer.
      const { writer, supervisor, start, turn } = rig();
      await start();
      supervisor.noteUserInput("b1");
      turn();
      expect(writer).not.toHaveBeenCalled();
    });

    it("an operator-typed message is one", async () => {
      const { writer, supervisor, composer, start, state } = rig();
      await start();
      composer.verdict = "draft";
      supervisor.noteUserInput("b1");
      expect(writer).not.toHaveBeenCalled();
      // Submitted: the draft leaves the composer and the turn begins.
      composer.verdict = "empty";
      state("working");
      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer).toHaveBeenCalledWith("b1", buildOnboardNudge());
    });

    it("mail is one", async () => {
      const { writer, supervisor, start } = rig();
      await start();
      supervisor.noteMailWritten("b1");
      expect(writer).toHaveBeenCalledTimes(1);
    });
  });

  describe("a message the operator types and sends", () => {
    it("counts from the Enter, when no draft frame was ever seen", async () => {
      // A fast typist, or a paste sent at once: the composer still reads
      // empty when Enter arrives, and the turn starts before any repaint.
      const { writer, supervisor, start, state } = rig();
      await start();
      supervisor.noteUserInput("b1", undefined, "first message");
      supervisor.noteUserInput("b1", undefined, "\r");
      expect(writer).not.toHaveBeenCalled();
      state("working");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("counts a paste and its Enter arriving as one chunk", async () => {
      const { writer, supervisor, start, state } = rig();
      await start();
      supervisor.noteUserInput("b1", undefined, "\u001b[200~first message\u001b[201~\r");
      state("working");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("counts on a harness whose draft the probes cannot read", async () => {
      const { writer, supervisor, composer, start, state } = rig();
      await start();
      composer.verdict = null;
      for (const ch of "hello") supervisor.noteUserInput("b1", undefined, ch);
      supervisor.noteUserInput("b1", undefined, "\r");
      state("working");
      // The gate still decides when it can be typed; the message is counted.
      composer.verdict = "empty";
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("a lone Enter, an arrow key, or a one-key answer on an unread screen is a dialog, not a message", async () => {
      for (const keys of [["\r"], ["\u001b[B", "\r"], ["1", "\r"], ["y\r"]]) {
        const { writer, supervisor, composer, start, turn } = rig();
        await start();
        composer.verdict = null;
        for (const key of keys) supervisor.noteUserInput("b1", undefined, key);
        turn();
        turn();
        expect(writer, JSON.stringify(keys)).not.toHaveBeenCalled();
      }
    });

    it("Enter while the seat asks for attention answers the seat, it does not start a conversation", async () => {
      const { writer, supervisor, start, state } = rig();
      await start();
      state("attention");
      supervisor.noteUserInput("b1", undefined, "yes please\r");
      state("working");
      state("idle");
      expect(writer).not.toHaveBeenCalled();
    });

    it("Enter on an empty composer starts nothing, and a turn long after is not the operator's", async () => {
      const { writer, supervisor, start, state } = rig();
      const clock = { now: 1_000_000 };
      supervisor.setNow(() => clock.now);
      await start();
      supervisor.noteUserInput("b1", clock.now, "\r");
      state("working");
      state("idle");
      expect(writer).not.toHaveBeenCalled();
      // A real message whose turn never started, then an unrelated turn later.
      supervisor.noteUserInput("b1", clock.now, "hello there\r");
      clock.now += 60_000;
      state("working");
      expect(writer).not.toHaveBeenCalled();
    });
  });

  describe("a nudge the gate holds", () => {
    it("goes out when the input box is free again, with no other event, and only then counts", async () => {
      const writer = vi.fn<NoticeWriter>().mockReturnValueOnce(false).mockReturnValue(true);
      const { supervisor, start, state, turn } = rig(writer);
      await start();
      state("working");
      supervisor.noteMailWritten("b1");
      expect(writer).toHaveBeenCalledTimes(1);
      // The drive says the box is typeable again. Nothing else has happened.
      supervisor.noteWritable("b1");
      expect(writer).toHaveBeenCalledTimes(2);
      // Held once, sent once: that was the first of the two, not the second.
      state("idle");
      turn();
      turn();
      expect(writer).toHaveBeenCalledTimes(2);
      state("working");
      expect(writer).toHaveBeenCalledTimes(3);
    });

    it("a writable signal sends nothing that is not due", async () => {
      const { writer, supervisor, start } = rig();
      supervisor.noteWritable("b1");
      await start();
      supervisor.noteWritable("b1");
      expect(writer).not.toHaveBeenCalled();
      supervisor.noteOnboarded("b1");
      supervisor.noteMailWritten("b1");
      supervisor.noteWritable("b1");
      expect(writer).not.toHaveBeenCalled();
    });
  });

  describe("does not wait for the turn to end", () => {
    it("interjects while the first turn is still running", async () => {
      const { writer, supervisor, start, state } = rig();
      await start();
      supervisor.noteMailWritten("b1");
      state("working");
      // The turn may run for hours; the nudge is already in.
      expect(writer).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i += 1) supervisor.onSnapshot(snap({ seq: BigInt(10 + i) }));
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("mail typed into a running turn is followed at once", async () => {
      const { writer, supervisor, start, state } = rig();
      await start();
      state("working");
      expect(writer).not.toHaveBeenCalled();
      supervisor.noteMailWritten("b1");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("the second nudge goes in as its turn starts, not when it ends", async () => {
      const { writer, start, state, mailTurn, turn } = rig();
      await start();
      mailTurn();
      turn();
      turn();
      expect(writer).toHaveBeenCalledTimes(1);
      state("working");
      expect(writer).toHaveBeenCalledTimes(2);
    });
  });

  describe("never while the operator is drafting or a dialog is up", () => {
    it("holds for an operator draft and sends once it is gone", async () => {
      const { writer, supervisor, composer, start, state } = rig();
      await start();
      state("working");
      // The operator is already typing the next message as the mail lands.
      composer.verdict = "draft";
      supervisor.noteMailWritten("b1");
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).not.toHaveBeenCalled();
      composer.verdict = "empty";
      supervisor.onSnapshot(snap({ seq: 3n }));
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("holds while a dialog is up", async () => {
      const { writer, supervisor, composer, start, state } = rig();
      await start();
      state("working");
      state("attention");
      composer.verdict = null;
      supervisor.noteMailWritten("b1");
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).not.toHaveBeenCalled();
      // The dialog is answered and the turn runs on.
      composer.verdict = "empty";
      state("working");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("a nudge the drive could not type spends nothing and is tried again", async () => {
      const writer = vi.fn<NoticeWriter>().mockReturnValueOnce(false).mockReturnValue(true);
      const { supervisor, start } = rig(writer);
      await start();
      supervisor.noteMailWritten("b1");
      expect(writer).toHaveBeenCalledTimes(1);
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).toHaveBeenCalledTimes(2);
      supervisor.onSnapshot(snap({ seq: 3n }));
      expect(writer).toHaveBeenCalledTimes(2);
    });

    it.each(["throw", "reject"] as const)("a %s from the transport spends nothing", async (failure) => {
      const writer = vi.fn<NoticeWriter>().mockImplementationOnce(() => {
        if (failure === "throw") throw new Error("transport failed");
        return Promise.reject(new Error("transport failed"));
      }).mockReturnValue(true);
      const { supervisor, start, mailTurn } = rig(writer);
      await start();
      expect(() => mailTurn()).not.toThrow();
      await settled();
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).toHaveBeenCalledTimes(2);
    });

    it("reserves one nudge while its receipt is unresolved", async () => {
      let accept!: (value: boolean) => void;
      const writer = vi.fn<NoticeWriter>().mockImplementationOnce(
        () => new Promise<boolean>((resolve) => { accept = resolve; }),
      ).mockReturnValue(true);
      const { supervisor, start, mailTurn, turn } = rig(writer);
      await start();
      mailTurn();
      supervisor.onSnapshot(snap({ seq: 2n }));
      turn();
      turn();
      expect(writer).toHaveBeenCalledTimes(1);
      accept(true);
      await settled();
      // The two turns that started while the receipt was pending count
      // toward the second nudge: one more makes the three.
      expect(writer).toHaveBeenCalledTimes(1);
      turn();
      expect(writer).toHaveBeenCalledTimes(2);
    });
  });

  describe("exactly two nudges, at the stated turns", () => {
    it("one in the first turn, one in the third turn after it, then none", async () => {
      const { writer, start, mailTurn, turn } = rig();
      await start();
      const sentIn: number[] = [];
      mailTurn();
      if (writer.mock.calls.length === 1) sentIn.push(1);
      for (let started = 2; started <= 20; started += 1) {
        const before = writer.mock.calls.length;
        turn();
        if (writer.mock.calls.length > before) sentIn.push(started);
      }
      expect(sentIn).toEqual([1, 4]);
      expect(writer.mock.calls.every(([, text]) => text === buildOnboardNudge())).toBe(true);
    });

    it("later mail into the same turn does not count as another turn", async () => {
      const { writer, supervisor, start, state } = rig();
      await start();
      supervisor.noteMailWritten("b1");
      state("working");
      for (let i = 0; i < 6; i += 1) supervisor.noteMailWritten("b1");
      state("idle");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("the operator's own nudge counts, so the cadence does not repeat it", async () => {
      const { writer, supervisor, start, mailTurn, turn } = rig();
      await start();
      mailTurn();
      expect(writer).toHaveBeenCalledTimes(1);
      supervisor.noteNudgeDelivered("b1");
      for (let i = 0; i < 10; i += 1) turn();
      expect(writer).toHaveBeenCalledTimes(1);
    });
  });

  describe("stops for good once the seat onboards", () => {
    it("only `junto onboard` onboards, and nothing is typed after it", async () => {
      const { writer, supervisor, events, start, mailTurn, turn } = rig();
      await start();
      expect(supervisor.isOnboarded("b1")).toBe(false);
      mailTurn();
      expect(writer).toHaveBeenCalledTimes(1);
      supervisor.noteOnboarded("b1");
      expect(supervisor.isOnboarded("b1")).toBe(true);
      for (let i = 0; i < 10; i += 1) turn();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.status)).toEqual(["not-onboarded", "onboarded"]);
    });

    it("an onboard that arrives before the seat's first event still counts", async () => {
      const { writer, supervisor, start, mailTurn, turn } = rig();
      supervisor.noteOnboarded("b1");
      expect(supervisor.isOnboarded("b1")).toBe(true);
      await start();
      mailTurn();
      for (let i = 0; i < 5; i += 1) turn();
      expect(writer).not.toHaveBeenCalled();
      expect(supervisor.isOnboarded("b1")).toBe(true);
    });
  });

  describe("a session that has offboarded and is waiting to close", () => {
    it("is not nudged when its offboard turn ends, however due a nudge is", async () => {
      // The operator's report: the seat never onboarded, ran junto offboard,
      // and the nudge was typed into the session as its turn ended.
      const writer = vi.fn<NoticeWriter>().mockReturnValueOnce(false).mockReturnValue(true);
      const { supervisor, start, state } = rig(writer);
      await start();
      state("working");
      supervisor.noteMailWritten("b1");
      // The first nudge was held by the gate for the whole turn.
      expect(writer).toHaveBeenCalledTimes(1);
      supervisor.noteOffboardSaved("b1");
      state("idle");
      supervisor.noteWritable("b1");
      supervisor.onSnapshot(snap({ seq: 5n }));
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("gets no second nudge either, while it waits to be closed", async () => {
      const { writer, supervisor, start, mailTurn, turn, state } = rig();
      await start();
      mailTurn();
      turn();
      turn();
      expect(writer).toHaveBeenCalledTimes(1);
      supervisor.noteOffboardSaved("b1");
      // The turn that would have earned the second nudge.
      state("working");
      state("idle");
      for (let i = 0; i < 4; i += 1) turn();
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("the session that replaces it starts clean and is nudged like any other", async () => {
      const { writer, supervisor, session, start, mailTurn, exit } = rig();
      await start();
      mailTurn();
      supervisor.noteOffboardSaved("b1");
      exit();
      session.id = "session-2";
      await start("e2");
      mailTurn();
      expect(writer).toHaveBeenCalledTimes(2);
    });

    it("an offboard for a seat the supervisor has not seen is ignored", () => {
      const { supervisor } = rig();
      expect(() => supervisor.noteOffboardSaved("nope")).not.toThrow();
      expect(() => supervisor.noteOffboardSaved(undefined)).not.toThrow();
    });
  });

  describe("the status follows the harness session", () => {
    it("a resumed onboarded session is not nudged again", async () => {
      const { writer, supervisor, onboardedSessions, start, mailTurn, turn, exit } = rig();
      await start();
      mailTurn();
      supervisor.noteOnboarded("b1");
      await settled();
      expect(onboardedSessions.has("session-1")).toBe(true);
      expect(writer).toHaveBeenCalledTimes(1);

      // The process exits; the seat later resumes the same harness session.
      exit();
      expect(supervisor.isOnboarded("b1")).toBe(false);
      await start("e2");
      expect(supervisor.isOnboarded("b1")).toBe(true);
      mailTurn();
      for (let i = 0; i < 10; i += 1) turn();
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("a fresh session on the same seat starts not onboarded and is nudged", async () => {
      const { writer, supervisor, session, events, start, mailTurn, exit } = rig();
      await start();
      supervisor.noteOnboarded("b1");
      await settled();
      exit();
      session.id = "session-2";
      await start("e2");
      expect(supervisor.isOnboarded("b1")).toBe(false);
      expect(events.at(-1)?.status).toBe("not-onboarded");
      mailTurn();
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("nothing is typed while a resumed session's status is still being read", async () => {
      const { writer, supervisor, start, mailTurn, turn, exit } = rig();
      await start();
      supervisor.noteOnboarded("b1");
      await settled();
      exit();
      // No await between the generation's first event and its first turns.
      void start("e2");
      mailTurn();
      turn();
      expect(writer).not.toHaveBeenCalled();
      await settled();
      turn();
      expect(writer).not.toHaveBeenCalled();
      expect(supervisor.isOnboarded("b1")).toBe(true);
    });

    it("a status that cannot be read yet is not 'not onboarded': it is asked again, and nothing is typed meanwhile", async () => {
      // Right after Junto restarts, a resumed seat's first events can arrive
      // before its canvas can be read. The session DID onboard; the record
      // just cannot be reached yet.
      const answers: Array<boolean | undefined> = [undefined, undefined, true];
      const supervisor = new InjectionSupervisor();
      const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
      const asked: number[] = [];
      supervisor.setWriter(writer);
      supervisor.setOnboardedRecord({
        load: async () => {
          asked.push(asked.length);
          return answers.shift();
        },
        save: async () => true,
      });
      const state = (value: AgentSeatStateEvent["state"]) => supervisor.noteSeatState(seatEvent({ state: value }));
      state("idle");
      await settled();
      expect(supervisor.isOnboarded("b1")).toBe(false);
      expect(supervisor.currentOnboarding()).toEqual([]);
      // Mail wakes it and a turn runs: a nudge would be due if it were unonboarded.
      supervisor.noteMailWritten("b1");
      state("working");
      await settled();
      state("idle");
      await settled();
      expect(writer).not.toHaveBeenCalled();
      expect(supervisor.isOnboarded("b1")).toBe(true);
      expect(asked.length).toBe(3);
      // And once it is known, it is not asked again.
      state("working");
      state("idle");
      await settled();
      expect(asked.length).toBe(3);
    });

    it("a status that can be read and says no is believed at once", async () => {
      const supervisor = new InjectionSupervisor();
      const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
      supervisor.setWriter(writer);
      supervisor.setOnboardedRecord({ load: async () => false, save: async () => true });
      supervisor.noteSeatState(seatEvent({ state: "idle" }));
      await settled();
      supervisor.noteMailWritten("b1");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("a record that fails to read is asked again, not taken for 'not onboarded'", async () => {
      let calls = 0;
      const supervisor = new InjectionSupervisor();
      const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
      supervisor.setWriter(writer);
      supervisor.setOnboardedRecord({
        load: async () => {
          calls += 1;
          if (calls === 1) throw new Error("canvas not loaded");
          return true;
        },
        save: async () => true,
      });
      supervisor.noteSeatState(seatEvent({ state: "idle" }));
      await settled();
      supervisor.noteMailWritten("b1");
      await settled();
      expect(writer).not.toHaveBeenCalled();
      expect(supervisor.isOnboarded("b1")).toBe(true);
    });

    it("records a session whose id is learned after it onboarded", async () => {
      // A harness that mints its session id without printing it is captured
      // at a later turn boundary; the record is written then.
      const { supervisor, session, onboardedSessions, start, mailTurn, turn } = rig();
      session.id = undefined;
      await start();
      mailTurn();
      supervisor.noteOnboarded("b1");
      await settled();
      expect(onboardedSessions.size).toBe(0);
      session.id = "captured-1";
      supervisor.noteMailWritten("b1");
      turn();
      await settled();
      expect(onboardedSessions.has("captured-1")).toBe(true);
    });

    it("an old generation's late answer never touches the new one", async () => {
      const answers: Array<(value: boolean) => void> = [];
      const supervisor = new InjectionSupervisor();
      const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
      supervisor.setWriter(writer);
      supervisor.setOnboardedRecord({
        load: () => new Promise<boolean>((resolve) => { answers.push(resolve); }),
        save: async () => true,
      });
      supervisor.noteSeatState(seatEvent({ epoch: "e1" }));
      supervisor.noteSeatState(seatEvent({ epoch: "e1", state: "gone" }));
      supervisor.noteSeatState(seatEvent({ epoch: "e2" }));
      answers[0]!(true);
      await settled();
      expect(supervisor.isOnboarded("b1")).toBe(false);
      answers[1]!(false);
      await settled();
      expect(supervisor.isOnboarded("b1")).toBe(false);
      expect(supervisor.currentOnboarding()).toEqual([
        expect.objectContaining({ bindingId: "b1", status: "not-onboarded" }),
      ]);
    });
  });
});
