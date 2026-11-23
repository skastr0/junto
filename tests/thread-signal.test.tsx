// @vitest-environment jsdom
/**
 * How a signal reads inside a thread: the frame round the seat's message, the
 * line above the operator's answer, the mark under mail that has not arrived,
 * and what the reply field says a reply will answer. Props only.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AnswerTo, ReplyAnswers, SignalFrame, WaitingMark } = await import("../src/window/components/threads/ThreadSignal");
type ThreadSignal = import("../src/window/components/threads/ThreadSignal").ThreadSignal;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (node: ReactNode): Promise<void> => {
  await act(async () => root.render(node));
};
const q = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
/** What is read out: the text with every run of space as one. */
const words = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const press = (el: Element | null): void => {
  act(() => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const signal = (over: Partial<ThreadSignal> = {}): ThreadSignal => ({ signalId: "s1", kind: "blocked", state: "open", ...over });

describe("a signal message", () => {
  it("says its kind and that it is open, round the message as it reads", async () => {
    await render(
      <SignalFrame signal={signal()} onHandIn={() => undefined}>
        <p data-testid="message">The migration number is taken.</p>
      </SignalFrame>,
    );
    const frame = q("seat-threads-signal")!;
    // The hue comes off the kind, the tint off the state; the words say both.
    expect(frame.getAttribute("data-signal-kind")).toBe("blocked");
    expect(frame.getAttribute("data-state")).toBe("open");
    expect(words(frame.querySelector(".seat-threads__signal-line"))).toBe("Blocked, Open");
    expect(frame.contains(q("message"))).toBe(true);
    // An open signal's state is the word alone; the glyphs are for a closed one.
    expect(q("seat-threads-signal-state")!.querySelector("svg")).toBeNull();
    // A plain signal has no button: the reply answers it.
    expect(q("seat-threads-signal-hand-in")).toBeNull();
  });

  it("names each kind a seat raises in its own word", async () => {
    for (const [kind, word] of [["blocked", "Blocked"], ["escalate", "Escalate"], ["feedback", "Feedback"]] as const) {
      await render(
        <SignalFrame signal={signal({ kind })} onHandIn={() => undefined}>
          <p>text</p>
        </SignalFrame>,
      );
      expect(q("seat-threads-signal")!.getAttribute("data-signal-kind")).toBe(kind);
      expect(words(q("seat-threads-signal")!.querySelector(".seat-threads__signal-kind"))).toBe(word);
      // The kind's glyph is drawn, and is not said.
      expect(q("seat-threads-signal")!.querySelector(".seat-threads__signal-line > svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("says a closed signal's state in a word with its glyph, and keeps what was asked", async () => {
    for (const [state, word] of [["answered", "Answered"], ["dismissed", "Dismissed"], ["withdrawn", "Withdrawn"]] as const) {
      await render(
        <SignalFrame signal={signal({ state })} onHandIn={() => undefined}>
          <p data-testid="message">What was asked.</p>
        </SignalFrame>,
      );
      expect(q("seat-threads-signal")!.getAttribute("data-state")).toBe(state);
      expect(words(q("seat-threads-signal-state"))).toBe(word);
      expect(q("seat-threads-signal-state")!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(words(q("message"))).toBe("What was asked.");
    }
  });

  it("carries Hand in while it is open and asks for work, and opens that signal", async () => {
    const handIn = vi.fn();
    await render(
      <SignalFrame signal={signal({ signalId: "s7", work: "document" })} onHandIn={handIn}>
        <p>Write the plan.</p>
      </SignalFrame>,
    );
    expect(words(q("seat-threads-signal-hand-in"))).toBe("Hand in");
    press(q("seat-threads-signal-hand-in"));
    expect(handIn.mock.calls).toEqual([["s7"]]);

    // Handed in, the signal is answered and the button is gone.
    await render(
      <SignalFrame signal={signal({ signalId: "s7", work: "document", state: "answered" })} onHandIn={handIn}>
        <p>Write the plan.</p>
      </SignalFrame>,
    );
    expect(q("seat-threads-signal-hand-in")).toBeNull();
  });
});

describe("the operator's side", () => {
  it("says what an answer answered, by the kind's word", async () => {
    await render(<AnswerTo kind="escalate" />);
    expect(words(q("seat-threads-answer-to"))).toBe("Answer to Escalate");
    expect(q("seat-threads-answer-to")!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says mail has not reached its seat, politely, in the one wording", async () => {
    await render(<WaitingMark name="pty-lead" />);
    const mark = q("seat-threads-waiting")!;
    expect(words(mark)).toBe("Waiting for pty-lead. It arrives when the seat is back.");
    expect(mark.getAttribute("role")).toBe("status");
    expect(mark.getAttribute("aria-live")).toBe("polite");
  });
});

describe("what a reply will answer", () => {
  const show = vi.fn();
  const handIn = vi.fn();
  beforeEach(() => {
    show.mockClear();
    handIn.mockClear();
  });
  const line = async (open: ReadonlyArray<ThreadSignal>): Promise<void> => {
    await render(<ReplyAnswers open={open} onShow={show} onHandIn={handIn} />);
  };

  it("says nothing when nothing is open", async () => {
    await line([]);
    expect(q("thread-composer-answers")).toBeNull();
  });

  it("names the one open signal a reply answers, and brings it into view", async () => {
    await line([signal({ signalId: "s3", kind: "feedback" })]);
    const plain = q("thread-composer-answers-plain")!;
    expect(words(plain)).toBe("Your reply answers Feedback");
    expect(plain.tagName).toBe("BUTTON");
    expect(plain.querySelector(".seat-threads__signal-kind")?.getAttribute("data-signal-kind")).toBe("feedback");
    press(plain);
    expect(show.mock.calls).toEqual([["s3"]]);
    expect(q("thread-composer-answers-work")).toBeNull();
  });

  it("counts several, since a reply answers every open plain signal, and shows the earliest", async () => {
    await line([signal({ signalId: "s1" }), signal({ signalId: "s2", kind: "escalate" })]);
    expect(words(q("thread-composer-answers-plain"))).toBe("Your reply answers 2 open signals");
    press(q("thread-composer-answers-plain"));
    expect(show.mock.calls).toEqual([["s1"]]);
  });

  it("says a reply leaves a signal that asks for work open, with Hand in", async () => {
    await line([signal({ signalId: "s4", work: "document" })]);
    expect(q("thread-composer-answers-plain")).toBeNull();
    expect(words(q("thread-composer-answers-work"))).toBe("Your reply leaves Blocked open: it asks for a document.Hand in");
    press(q("thread-composer-answers-hand-in"));
    expect(handIn.mock.calls).toEqual([["s4"]]);
  });

  it("says each kind of work in its own words", async () => {
    await line([
      signal({ signalId: "a", work: "document" }),
      signal({ signalId: "b", work: "proof", kind: "feedback" }),
      signal({ signalId: "c", work: "secret", kind: "escalate" }),
    ]);
    expect(all("thread-composer-answers-work").map((el) => words(el.querySelector("span")))).toEqual([
      "Your reply leaves Blocked open: it asks for a document.",
      "Your reply leaves Feedback open: it asks for proof.",
      "Your reply leaves Escalate open: it asks for a secret.",
    ]);
  });

  it("says the plain line first, then the one that stays open, when both are open", async () => {
    await line([signal({ signalId: "w", work: "proof" }), signal({ signalId: "p", kind: "escalate" })]);
    const lines = [...q("thread-composer-answers")!.children].map((el) => el.getAttribute("data-testid"));
    expect(lines).toEqual(["thread-composer-answers-plain", "thread-composer-answers-work"]);
    expect(words(q("thread-composer-answers-plain"))).toBe("Your reply answers Escalate");
  });
});
