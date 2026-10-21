// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintItemId } from "../src/shared/resource-command";
import type { SubjectThread } from "../src/renderer/lib/subject-threads-source";
import { ArtifactComments } from "../src/renderer/components/artifacts/ArtifactComments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const thread = (text: string, at: number): SubjectThread => ({
  threadId: mintItemId(),
  posts: [{ messageId: mintItemId(), author: { kind: "operator" }, text, at }],
});

const render = (threads: ReadonlyArray<SubjectThread>, onStart: (text: string, anchor: unknown) => Promise<string | null> = vi.fn(async () => null)) =>
  act(() =>
    root.render(
      <ArtifactComments
        canvasName="c"
        mentionable={[]}
        threads={threads}
        draftAnchor={undefined}
        now={10_000}
        onStart={onStart}
        onReply={async () => null}
        nodeKindOf={() => undefined}
        onOpenMention={() => {}}
        onClearAnchor={() => {}}
      />,
    ),
  );

describe("artifact comments rail", () => {
  it("lists every thread in time order, with no resolve", () => {
    render([thread("first", 1), thread("second", 2)]);
    expect([...host.querySelectorAll(".artifact-thread__text")].map((p) => p.textContent)).toEqual(["first", "second"]);
    expect(host.textContent).not.toMatch(/Resolve|Reopen/u);
    expect(host.textContent).toContain("Comments, 2");
  });

  it("composes in the mention combobox and starts a thread on the whole artifact", async () => {
    const onStart = vi.fn(async () => null);
    render([], onStart);
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New comment"]')!;
    expect(field.getAttribute("role")).toBe("combobox");
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(field, "looks good");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Comment")?.click());
    expect(onStart).toHaveBeenCalledWith("looks good", undefined);
    expect(field.value).toBe("");
  });

  it("keeps a refused comment in its composer and says why", async () => {
    render([], async () => "Ghost cannot be mentioned here");
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New comment"]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(field, "hi @ghost");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Comment")?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Ghost cannot be mentioned here");
    expect(field.value).toBe("hi @ghost");
  });
});
