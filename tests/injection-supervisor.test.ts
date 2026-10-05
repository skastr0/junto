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
      const { writer, start, operatorTurn } = rig();
      await start();
      operatorTurn();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(writer).toHaveBeenCalledWith("b1", buildOnboardNudge());
    });

    it("mail is one", async () => {
      const { writer, start, mailTurn } = rig();
      await start();
      mailTurn();
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("mail typed mid-turn counts the turn it lands in", async () => {
      const { writer, supervisor, start, state } = rig();
      await start();
      state("working");
      supervisor.noteMailWritten("b1");
      expect(writer).not.toHaveBeenCalled();
      state("idle");
      expect(writer).toHaveBeenCalledTimes(1);
    });
  });

  describe("only at a completed turn, never while drafting or on a dialog", () => {
    it("holds for an operator draft and sends once it is gone", async () => {
      const { writer, supervisor, composer, start, state } = rig();
      await start();
      supervisor.noteMailWritten("b1");
      state("working");
      // The operator starts typing the next message before the turn ends.
      composer.verdict = "draft";
      state("idle");
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).not.toHaveBeenCalled();
      composer.verdict = "empty";
      supervisor.onSnapshot(snap({ seq: 3n }));
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("holds while a dialog is up", async () => {
      const { writer, supervisor, composer, start, state } = rig();
      await start();
      supervisor.noteMailWritten("b1");
      state("working");
      state("attention");
      composer.verdict = null;
      supervisor.onSnapshot(snap({ seq: 2n }));
      expect(writer).not.toHaveBeenCalled();
      // The dialog is answered and the turn runs to its end.
      composer.verdict = "empty";
      state("working");
      state("idle");
      expect(writer).toHaveBeenCalledTimes(1);
    });

    it("never writes mid-turn", async () => {
      const { writer, supervisor, start, state, mailTurn } = rig();
      await start();
      mailTurn();
      expect(writer).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 3; i += 1) {
        state("working");
        supervisor.onSnapshot(snap({ seq: BigInt(10 + i) }));
        expect(writer).toHaveBeenCalledTimes(1);
        state("idle");
      }
      expect(writer).toHaveBeenCalledTimes(2);
    });

    it("a nudge the drive refuses spends nothing and is tried again", async () => {
      const writer = vi.fn<NoticeWriter>().mockReturnValueOnce(false).mockReturnValue(true);
      const { supervisor, start, mailTurn } = rig(writer);
      await start();
      mailTurn();
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
      expect(writer).toHaveBeenCalledTimes(1);
      accept(true);
      await settled();
      // The turn that ran while the receipt was pending counts toward the
      // second nudge: two more complete the three.
      turn();
      expect(writer).toHaveBeenCalledTimes(1);
      turn();
      expect(writer).toHaveBeenCalledTimes(2);
    });
  });

  describe("exactly two nudges, at the stated turns", () => {
    it("one after the first completed turn, one three turns later, then none", async () => {
      const { writer, start, mailTurn, turn } = rig();
      await start();
      const sentAfter: number[] = [];
      mailTurn();
      if (writer.mock.calls.length === 1) sentAfter.push(1);
      for (let completed = 2; completed <= 20; completed += 1) {
        const before = writer.mock.calls.length;
        turn();
        if (writer.mock.calls.length > before) sentAfter.push(completed);
      }
      expect(sentAfter).toEqual([1, 4]);
      expect(writer.mock.calls.every(([, text]) => text === buildOnboardNudge())).toBe(true);
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
