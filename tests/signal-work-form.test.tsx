// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { asCanvasName } from "../src/shared/model";
import { SignalWorkForm } from "../src/renderer/components/signals/SignalWorkForm";
import type { SignalActionResult } from "../src/renderer/lib/agent-signals-view";
import { keepWorkDraft, type SignalForm, type WorkReply } from "../src/renderer/lib/signal-work";
import { modelStore } from "../src/renderer/lib/use-model";
import { settleLazy } from "./support/settle-lazy";
import { artifacts } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const CANVAS = "signal-work";
const writing: SignalForm = { kind: "artifact", nodeId: "shelf-1", title: "Morning pages", labels: ["daily"], minWords: 5 };

let host: HTMLDivElement;
let root: Root;
let release: () => void;
let handed: Array<WorkReply>;
let dismissed: Array<string>;
let answer: SignalActionResult;
let done: number;

const draw = async (form: SignalForm & { readonly kind: "artifact" | "proof" }, signalId = "sig-1"): Promise<void> => {
  await act(async () =>
    root.render(
      <SignalWorkForm
        signalId={signalId}
        canvasName={CANVAS}
        text="Write 5 words"
        form={form}
        handIn={async (_id, reply) => {
          handed.push(reply);
          return answer;
        }}
        dismiss={async (id) => {
          dismissed.push(id);
          return { ok: true };
        }}
        onDone={() => {
          done += 1;
        }}
      />,
    ),
  );
  await settleLazy();
};

const typeAtEnd = async (text: string): Promise<void> =>
  act(async () => {
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    const at = view.state.doc.length;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
  });

const button = (name: string): HTMLButtonElement =>
  [...document.body.querySelectorAll("button")].filter((each) => each.textContent?.trim() === name).at(-1)!;

const typeInto = (label: string, text: string): void => {
  const field = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: [artifacts("shelf-1", { label: "Journal" })] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  handed = [];
  dismissed = [];
  answer = { ok: true };
  done = 0;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  release();
  keepWorkDraft("sig-1", "");
  keepWorkDraft("sig-2", "");
});

describe("work done in the signal", () => {
  it("an artifact form says where it lands, fills its condition as the operator writes, and hands in once it holds", async () => {
    await draw(writing);
    expect(host.querySelector(".signal-work__where")?.textContent).toBe("Becomes Morning pages in Journal, labelled daily");
    expect(host.querySelector(".signal-work__count")?.textContent).toBe("0 words of 5");
    const handIn = button("Hand in");
    expect(handIn.getAttribute("aria-disabled")).toBe("true");
    expect(handIn.title).toBe("5 more words to hand in");
    await act(async () => handIn.click());
    expect(handed).toEqual([]);

    await typeAtEnd("# Today\n\nOne two three");
    expect(host.querySelector(".signal-work__count")?.textContent).toBe("4 words of 5");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("4 words of 5");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");

    await typeAtEnd(" four.");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Enough words to hand in.");
    await act(async () => button("Hand in").click());
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ kind: "artifact", markdown: "# Today\n\nOne two three four." });
    expect(handed[0]!.replyId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(done).toBe(1);
  });

  it("writing not handed in is there again when the signal is opened again, and a refusal keeps it and says why", async () => {
    await draw(writing, "sig-2");
    await typeAtEnd("One two three four five");
    act(() => root.unmount());
    root = createRoot(host);
    await draw(writing, "sig-2");
    expect(host.querySelector(".signal-work__count")?.textContent).toBe("5 words of 5");

    answer = { ok: false, message: "4 words of 5" };
    await act(async () => button("Hand in").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("4 words of 5");
    expect(done).toBe(0);
    expect(host.querySelector(".signal-work__count")?.textContent).toBe("5 words of 5");
  });

  it("dismissing work asks first, and closes it undone only when confirmed", async () => {
    await draw(writing);
    await act(async () => button("Dismiss").click());
    expect(document.body.textContent).toContain("Dismiss this work?");
    await act(async () => button("Keep it").click());
    expect(dismissed).toEqual([]);
    await act(async () => button("Dismiss").click());
    await act(async () => button("Dismiss, not done").click());
    expect(dismissed).toEqual(["sig-1"]);
    expect(done).toBe(1);
  });

  it("a proof form takes what was done and links, refuses a link that is not one, and hands in the rest", async () => {
    await draw({ kind: "proof" });
    expect(button("Hand in").title).toBe("Say what you did, or add a link or a file");
    typeInto("What you did", "Posted the thread.");
    typeInto("Links, one per line", "https://example.com/post/1\nftp://nope");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("ftp://nope: only http and https addresses can be attached.");
    expect(button("Hand in").getAttribute("aria-disabled")).toBe("true");
    typeInto("Links, one per line", "https://example.com/post/1\n");
    await act(async () => button("Hand in").click());
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ kind: "proof", text: "Posted the thread.", links: ["https://example.com/post/1"], files: [] });
  });
});
