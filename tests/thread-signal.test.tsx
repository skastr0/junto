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

const { AnswerTo, ReplyAnswers, RowSignal, SignalFrame, ThreadSaid, WaitingMark, sentArrived, sentWaiting } = await import(
  "../src/window/components/threads/ThreadSignal"
);
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

const signal = (over: Partial<ThreadSignal> = {}): ThreadSignal => ({
  signalId: "s1",
  kind: "blocked",
  state: "open",
  text: "The migration number is taken.",
  ...over,
});
/** Who is in the thread. */
const KNOWN = ["you", "pty-lead"];

describe("a signal message", () => {
  it("says its kind and that it is open, round the message as it reads", async () => {
    await render(
      <SignalFrame author="pty-lead" known={KNOWN} signal={signal()} onHandIn={() => undefined}>
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

  it("names each kind a seat raises as the feed's card does, never by its command", async () => {
    for (const [kind, word] of [["blocked", "Blocked"], ["escalate", "Waiting on you"], ["feedback", "Ready for review"]] as const) {
      await render(
        <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ kind })} onHandIn={() => undefined}>
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
        <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ state })} onHandIn={() => undefined}>
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
      <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ signalId: "s7", asks: "document" })} onHandIn={handIn}>
        <p>Write the plan.</p>
      </SignalFrame>,
    );
    expect(words(q("seat-threads-signal-hand-in"))).toBe("Hand in");
    // Several can be open at once, so each button names its signal.
    expect(q("seat-threads-signal-hand-in")?.getAttribute("aria-label")).toBe("Hand in: The migration number is taken.");
    press(q("seat-threads-signal-hand-in"));
    expect(handIn.mock.calls).toEqual([["s7"]]);

    // Handed in, the signal is answered and the button is gone.
    await render(
      <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ signalId: "s7", asks: "document", state: "answered" })} onHandIn={handIn}>
        <p>Write the plan.</p>
      </SignalFrame>,
    );
    expect(q("seat-threads-signal-hand-in")).toBeNull();
  });
});

describe("a signal withdrawn as the answer was on its way", () => {
  it("says so under its body, in plain words, and only then", async () => {
    await render(
      <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ state: "withdrawn", crossed: true })} onHandIn={() => undefined}>
        <p>What was asked.</p>
      </SignalFrame>,
    );
    expect(words(q("seat-threads-signal-state"))).toBe("Withdrawn");
    expect(words(q("seat-threads-signal-crossed"))).toBe("pty-lead says it withdrew this before your answer reached it.");

    // Withdrawn with no answer on its way: the state word is the whole of it.
    await render(
      <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ state: "withdrawn" })} onHandIn={() => undefined}>
        <p>What was asked.</p>
      </SignalFrame>,
    );
    expect(q("seat-threads-signal-crossed")).toBeNull();
  });
});

describe("a signal answered as its withdrawal was on its way", () => {
  it("says the crossing the same way as a withdrawn one, once", async () => {
    await render(
      <SignalFrame author="pty-lead" known={KNOWN} signal={signal({ state: "answered", crossed: true })} onHandIn={() => undefined}>
        <p>What was asked.</p>
      </SignalFrame>,
    );
    expect(words(q("seat-threads-signal-state"))).toBe("Answered");
    expect(words(q("seat-threads-signal-crossed"))).toBe("pty-lead says it withdrew this before your answer reached it.");
  });
});

describe("the operator's side", () => {
  it("says what an answer answered, by that signal's headline", async () => {
    await render(<AnswerTo text="pty-lead: the migration number is taken." known={KNOWN} />);
    // The headline as a row draws it: the author's preamble is not part of it.
    expect(words(q("seat-threads-signal-headline"))).toBe("The migration number is taken.");
    expect(words(q("seat-threads-answer-to"))).toBe("Answer to: The migration number is taken.");
    expect(q("seat-threads-answer-to")!.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks a thread's row with its open signal: the kind's glyph, and the feed's words for a screen reader", async () => {
    await render(<RowSignal kind="escalate" />);
    const mark = q("seat-threads-row-signal")!;
    expect(mark.getAttribute("data-signal-kind")).toBe("escalate");
    expect(mark.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(words(mark.querySelector(".sr-only"))).toBe("open, waiting on you");
  });

  it("says under mail that it has not reached its seat, in the one wording, as plain words", async () => {
    await render(<WaitingMark name="pty-lead" />);
    const mark = q("seat-threads-waiting")!;
    expect(words(mark)).toBe("Waiting for pty-lead. It arrives when the seat is back.");
    expect(mark.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // Never a live region: a thread's history can hold many, and none of it is said aloud.
    expect(mark.hasAttribute("role")).toBe(false);
    expect(mark.hasAttribute("aria-live")).toBe(false);
  });
});

describe("what a thread says aloud", () => {
  it("is in the document, empty, before there is anything to say", async () => {
    await render(<ThreadSaid said={undefined} />);
    const region = q("seat-threads-said")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    // Said, not drawn: the mark under the message is what the eye gets.
    expect(region.className).toContain("sr-only");
  });

  it("takes its words into the region that was already there, and says the same words twice as two sayings", async () => {
    await render(<ThreadSaid said={undefined} />);
    const region = q("seat-threads-said")!;
    await render(<ThreadSaid said={{ text: sentWaiting("pty-lead"), turn: 1 }} />);
    expect(q("seat-threads-said")).toBe(region);
    expect(region.textContent).toBe("Sent. Waiting for pty-lead. It arrives when the seat is back.");
    const first = region.firstElementChild;
    await render(<ThreadSaid said={{ text: sentWaiting("pty-lead"), turn: 2 }} />);
    expect(q("seat-threads-said")).toBe(region);
    expect(region.textContent).toBe("Sent. Waiting for pty-lead. It arrives when the seat is back.");
    // A new node, so a screen reader hears the second send too.
    expect(region.firstElementChild).not.toBe(first);
    await render(<ThreadSaid said={{ text: sentArrived("pty-lead"), turn: 3 }} />);
    expect(region.textContent).toBe("pty-lead has it.");
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
    await render(<ReplyAnswers open={open} known={KNOWN} onShow={show} onHandIn={handIn} />);
  };

  it("says nothing when nothing is open", async () => {
    await line([]);
    expect(q("thread-composer-answers")).toBeNull();
  });

  it("names the one open signal a reply answers by its headline, and brings it into view", async () => {
    await line([signal({ signalId: "s3", kind: "feedback", text: "The switch is ready to look at." })]);
    const plain = q("thread-composer-answers-plain")!;
    expect(words(plain)).toBe("Your reply answers: The switch is ready to look at.");
    expect(plain.tagName).toBe("BUTTON");
    // Its name is the sentence, whole.
    expect(plain.getAttribute("aria-label")).toBe("Your reply answers: The switch is ready to look at.");
    press(plain);
    expect(show.mock.calls).toEqual([["s3"]]);
    expect(q("thread-composer-answers-work")).toBeNull();
  });

  it("counts several, since a reply answers every open plain signal, and shows the earliest", async () => {
    await line([signal({ signalId: "s1" }), signal({ signalId: "s2", kind: "escalate" })]);
    expect(words(q("thread-composer-answers-plain"))).toBe("Your reply answers 2 open signals");
    expect(q("thread-composer-answers-plain")!.getAttribute("aria-label")).toBe("Your reply answers 2 open signals");
    press(q("thread-composer-answers-plain"));
    expect(show.mock.calls).toEqual([["s1"]]);
  });

  it("says what closes a signal that asks for work, since a reply does not, with Hand in", async () => {
    await line([signal({ signalId: "s4", asks: "document" })]);
    expect(q("thread-composer-answers-plain")).toBeNull();
    expect(words(q("thread-composer-answers-work"))).toBe(
      "Stays open until a document is handed in: The migration number is taken. Hand in",
    );
    expect(q("thread-composer-answers-hand-in")!.getAttribute("aria-label")).toBe("Hand in: The migration number is taken.");
    press(q("thread-composer-answers-hand-in"));
    expect(handIn.mock.calls).toEqual([["s4"]]);
  });

  it("carries the id the reply field is described by", async () => {
    await render(<ReplyAnswers id="answers-1" open={[signal()]} known={KNOWN} onShow={show} onHandIn={handIn} />);
    expect(q("thread-composer-answers")!.id).toBe("answers-1");
  });

  it("says each kind of work in its own words", async () => {
    await line([
      signal({ signalId: "a", asks: "document" }),
      signal({ signalId: "b", asks: "proof", kind: "feedback" }),
      signal({ signalId: "c", asks: "secret", kind: "escalate" }),
    ]);
    expect(all("thread-composer-answers-work").map((el) => words(el.querySelector(".seat-threads__signal-lead")))).toEqual([
      "Stays open until a document is handed in:",
      "Stays open until proof is handed in:",
      "Stays open until a secret is handed in:",
    ]);
    // The headline is a whole sentence, so it always comes last.
    for (const el of all("thread-composer-answers-work")) {
      expect(el.querySelector(".seat-threads__signal-lead + .seat-threads__signal-headline")).not.toBeNull();
    }
  });

  it("says the plain line first, then the one that stays open, when both are open", async () => {
    await line([signal({ signalId: "w", asks: "proof" }), signal({ signalId: "p", kind: "escalate" })]);
    const lines = [...q("thread-composer-answers")!.children].map((el) => el.getAttribute("data-testid"));
    expect(lines).toEqual(["thread-composer-answers-plain", "thread-composer-answers-work"]);
    expect(words(q("thread-composer-answers-plain"))).toBe("Your reply answers: The migration number is taken.");
  });
});
