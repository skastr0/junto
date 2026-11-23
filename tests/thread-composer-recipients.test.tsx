// @vitest-environment jsdom
/**
 * The thread input with a row of recipients (Quick thread): one new thread
 * per chosen seat, the same text and files in each. Send says how many it
 * goes to before it goes. A seat that got nothing is named to the host and
 * the draft stays. @ offers only seats wired to every chosen seat, so no send
 * is refused for a mention. A held draft, text and files, outlives the
 * composer.
 */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperatorContentPut, OperatorContentPutResult } from "../src/shared/operator-attachments";
import { asCanvasName } from "../src/shared/model";
import { makeAttachmentHold, setOperatorContentPutter } from "../src/window/lib/operator-attachments";
import {
  resetSeatThreads,
  sendNewThreads,
  type HeldThreadDraft,
  type NewThreadsOutcome,
  type ThreadRecipient,
} from "../src/window/lib/seat-threads";
import { resetOperatorGesture } from "../src/window/lib/focus-ownership";
import { modelStore } from "../src/window/lib/use-model";
import { ThreadComposer } from "../src/window/components/threads/ThreadComposer";
import { seat as seatNode } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CANVAS = "composer-recipients";
const A: ThreadRecipient = { seatId: "seat-a", name: "pty-lead" };
const B: ThreadRecipient = { seatId: "seat-b", name: "cli-lead" };
const C: ThreadRecipient = { seatId: "seat-c", name: "canvas-lead" };

type Sent = { readonly nodeId: string; readonly text: string; readonly attachments?: ReadonlyArray<unknown> };

let host: HTMLDivElement;
let root: Root;
let sends: Sent[];
/** Seats whose send main refuses, with its words. */
let refused: Record<string, string>;
/** How main says a seat's mail went, when not delivered. */
let delivery: Record<string, "waiting_for_seat" | "failed">;
/** Who each seat is wired to. */
let wired: Record<string, ReadonlyArray<{ nodeId: string; name: string }>>;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const field = () => q("thread-composer-input") as HTMLTextAreaElement;
const sendButton = () => q("thread-composer-send") as HTMLButtonElement;
const type = async (value: string) => {
  const element = field();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const click = async (element: Element | null) => {
  act(() => (element as HTMLElement).click());
  await flush();
};

beforeEach(() => {
  sends = [];
  refused = {};
  delivery = {};
  wired = {};
  resetSeatThreads();
  resetOperatorGesture();
  modelStore.adopt({
    canvas: asCanvasName(CANVAS),
    seq: 0,
    wires: [],
    nodes: [seatNode(A.seatId), seatNode(B.seatId), seatNode(C.seatId), seatNode("seat-x"), seatNode("seat-y")],
  });
  (window as { junto?: unknown }).junto = {
    seatThreadMentionables: async ({ nodeId }: { nodeId: string }) => wired[nodeId] ?? [],
    seatThreadSend: async (input: Sent) => {
      sends.push(input);
      const words = refused[input.nodeId];
      return words === undefined
        ? { ok: true, messageId: `m-${input.nodeId}`, threadId: `t-${input.nodeId}`, delivery: delivery[input.nodeId] ?? "delivered" }
        : { ok: false, reason: "failed", message: words };
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { junto?: unknown }).junto;
  setOperatorContentPutter(undefined);
});

const render = async (
  recipients: ReadonlyArray<ThreadRecipient>,
  more: {
    readonly onSentAll?: (outcome: NewThreadsOutcome) => void;
    readonly held?: HeldThreadDraft;
    readonly holds?: () => boolean;
    readonly sender?: { current: ((to: ReadonlyArray<ThreadRecipient>) => void) | null };
  } = {},
) => {
  act(() =>
    root.render(
      <ThreadComposer
        mode="new"
        canvasName={CANVAS}
        recipients={recipients}
        recipientsRow={<div data-testid="row">{recipients.map((seat) => seat.name).join(" ")}</div>}
        {...more}
      />,
    ),
  );
  await flush();
};

describe("one send to several seats", () => {
  it("tries every seat, names the one that got nothing, and says which seat the mail waits for", async () => {
    refused[B.seatId] = "cli-lead is not reachable.";
    delivery[C.seatId] = "waiting_for_seat";
    const outcome = await sendNewThreads(CANVAS, [A.seatId, B.seatId, C.seatId], { text: "status?" });
    expect(sends.map((send) => send.nodeId)).toEqual([A.seatId, B.seatId, C.seatId]);
    expect(sends.every((send) => send.text === "status?")).toBe(true);
    expect(outcome.sent).toEqual([
      { seatId: A.seatId, threadId: "t-seat-a", arrival: "arrived" },
      { seatId: C.seatId, threadId: "t-seat-c", arrival: "waiting" },
    ]);
    expect(outcome.failed).toEqual([{ seatId: B.seatId, message: "cli-lead is not reachable." }]);
  });

  it("names every seat when the bridge is down", async () => {
    delete (window as { junto?: unknown }).junto;
    const outcome = await sendNewThreads(CANVAS, [A.seatId, B.seatId], { text: "status?" });
    expect(outcome.sent).toEqual([]);
    expect(outcome.failed.map((entry) => entry.seatId)).toEqual([A.seatId, B.seatId]);
  });
});

describe("the thread input with a row of recipients", () => {
  it("draws the host's row where the To line would be", async () => {
    await render([A, B]);
    expect(q("row")?.textContent).toBe("pty-lead cli-lead");
    expect(q("thread-composer-to")).toBeNull();
    expect(q("thread-composer")?.getAttribute("data-recipients")).toBe("2");
  });

  it("says how many it goes to before it goes, and sends nothing to nobody", async () => {
    await render([]);
    await type("status?");
    expect(sendButton().textContent).toBe("Send");
    expect(sendButton().disabled).toBe(true);

    await render([A]);
    expect(sendButton().textContent).toBe("Send");
    expect(sendButton().disabled).toBe(false);
    expect(field().getAttribute("aria-label")).toBe("New thread to pty-lead");

    await render([A, B, C]);
    expect(sendButton().textContent).toBe("Send to 3");
    expect(field().getAttribute("aria-label")).toBe("New thread to 3 seats");
  });

  it("starts one thread per seat with the same text, then is empty", async () => {
    const outcomes: NewThreadsOutcome[] = [];
    await render([A, B], { onSentAll: (outcome) => outcomes.push(outcome) });
    await type("status?");
    await click(sendButton());
    expect(sends).toEqual([
      { canvasName: CANVAS, nodeId: A.seatId, text: "status?" },
      { canvasName: CANVAS, nodeId: B.seatId, text: "status?" },
    ]);
    expect(outcomes).toEqual([
      {
        sent: [
          { seatId: A.seatId, threadId: "t-seat-a", arrival: "arrived" },
          { seatId: B.seatId, threadId: "t-seat-b", arrival: "arrived" },
        ],
        failed: [],
      },
    ]);
    expect(field().value).toBe("");
  });

  it("keeps the text when a seat got nothing, and tells the host which", async () => {
    refused[B.seatId] = "cli-lead is not reachable.";
    const outcomes: NewThreadsOutcome[] = [];
    await render([A, B], { onSentAll: (outcome) => outcomes.push(outcome) });
    await type("status?");
    await click(sendButton());
    expect(outcomes[0]?.sent.map((entry) => entry.seatId)).toEqual([A.seatId]);
    expect(outcomes[0]?.failed).toEqual([{ seatId: B.seatId, message: "cli-lead is not reachable." }]);
    expect(field().value).toBe("status?");

    // The host leaves only the seat that got nothing: Send goes to it alone.
    refused = {};
    sends.length = 0;
    await render([B], { onSentAll: (outcome) => outcomes.push(outcome) });
    await click(sendButton());
    expect(sends.map((send) => send.nodeId)).toEqual([B.seatId]);
    expect(field().value).toBe("");
  });

  it("offers after @ only the seats wired to every chosen seat", async () => {
    wired[A.seatId] = [
      { nodeId: "seat-x", name: "dev-lead" },
      { nodeId: "seat-y", name: "tech-lead" },
    ];
    wired[B.seatId] = [{ nodeId: "seat-y", name: "tech-lead" }];
    const offered = () => [...document.querySelectorAll('[data-testid="mention-option"]')].map((option) => option.textContent);

    await render([A]);
    await type("@");
    expect(offered().length).toBe(2);

    await render([A, B]);
    await type("@");
    expect(offered().length).toBe(1);
    expect(offered()[0]).toContain("tech-lead");
  });
});

describe("a send the host holds to ask first", () => {
  it("sends nothing on Send, then goes to exactly the seats the host fixed", async () => {
    const outcomes: NewThreadsOutcome[] = [];
    const sender = createRef<(to: ReadonlyArray<ThreadRecipient>) => void>();
    let asked = 0;
    await render([A, B, C], { onSentAll: (outcome) => outcomes.push(outcome), holds: () => ((asked += 1), true), sender });
    await type("stop");
    await click(sendButton());
    expect(asked).toBe(1);
    expect(sends).toEqual([]);
    expect(field().value).toBe("stop");

    // The set was fixed when the host asked: a seat chosen since gets nothing.
    await render([A, B, C, { seatId: "seat-d", name: "late-lead" }], {
      onSentAll: (outcome) => outcomes.push(outcome),
      holds: () => ((asked += 1), true),
      sender,
    });
    await act(async () => sender.current?.([A, C]));
    await flush();
    expect(asked).toBe(1);
    expect(sends.map((send) => send.nodeId)).toEqual([A.seatId, C.seatId]);
    expect(outcomes[0]?.sent.map((entry) => entry.seatId)).toEqual([A.seatId, C.seatId]);
    expect(field().value).toBe("");
  });

  it("is not asked with nothing to send, and sends as ever when the host lets it go", async () => {
    let asked = 0;
    await render([A, B], { holds: () => ((asked += 1), false) });
    await click(sendButton());
    expect(asked).toBe(0);
    await type("status?");
    await click(sendButton());
    expect(asked).toBe(1);
    expect(sends.map((send) => send.nodeId)).toEqual([A.seatId, B.seatId]);
  });

  it("sends to nobody when the host fixes nobody, and lets go of the host when it is gone", async () => {
    const sender = createRef<(to: ReadonlyArray<ThreadRecipient>) => void>();
    await render([A], { holds: () => true, sender });
    await type("status?");
    await act(async () => sender.current?.([]));
    await flush();
    expect(sends).toEqual([]);
    act(() => root.render(<div />));
    expect(sender.current).toBeNull();
  });
});

describe("a draft held past the composer", () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

  it("comes back with its text and its files", async () => {
    setOperatorContentPutter(async (input: OperatorContentPut): Promise<OperatorContentPutResult> => {
      const done = input.stage.done!;
      return {
        ok: true,
        result: { ref: { sha256: "a".repeat(64), byteLength: 3, mediaType: String(done.mediaType), displayName: String(done.displayName) } },
      } as OperatorContentPutResult;
    });
    let text = "";
    const held: HeldThreadDraft = { text: () => text, keepText: (next) => (text = next), files: makeAttachmentHold() };

    await render([A], { held });
    await type("see the shot");
    const picker = q("attach-files-input") as HTMLInputElement;
    Object.defineProperty(picker, "files", { value: [png()], configurable: true });
    act(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(held.files.items().map((item) => item.state)).toEqual(["ready"]);

    // Closed without sending, opened again.
    act(() => root.unmount());
    root = createRoot(host);
    await render([A], { held });
    expect(field().value).toBe("see the shot");
    expect(held.files.items().map((item) => item.name)).toEqual(["shot.png"]);

    await click(sendButton());
    expect(sends[0]?.attachments?.length).toBe(1);
    // Sent: nothing is held any more.
    expect(text).toBe("");
    expect(held.files.items()).toEqual([]);
  });
});

describe("the keyboard as the input mounts", () => {
  it("goes to the input, unless the input is asked to yield", async () => {
    act(() => root.render(<ThreadComposer mode="new" canvasName={CANVAS} recipients={[]} recipientsRow={null} yields={() => true} />));
    await flush();
    expect(document.activeElement).not.toBe(field());

    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<ThreadComposer mode="new" canvasName={CANVAS} recipients={[A]} recipientsRow={null} />));
    await flush();
    expect(document.activeElement).toBe(field());
  });

  it("hands the host its field", async () => {
    const seen: Array<HTMLTextAreaElement | null> = [];
    act(() =>
      root.render(
        <ThreadComposer mode="new" canvasName={CANVAS} recipients={[A]} recipientsRow={null} fieldRef={(element) => void seen.push(element)} />,
      ),
    );
    await flush();
    expect(seen.at(-1)).toBe(field());
  });
});
