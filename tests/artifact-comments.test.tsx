// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintItemId } from "../src/shared/resource-command";
import type { ArtifactThread } from "../src/renderer/lib/artifacts-source";
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

const thread = (text: string, at: number): ArtifactThread => ({
  threadId: mintItemId(),
  artifactId: mintItemId(),
  version: 1 as never,
  posts: [{ postId: mintItemId(), author: { kind: "operator" }, text, at }],
});

const render = (threads: ReadonlyArray<ArtifactThread>, onStart = vi.fn()) =>
  act(() =>
    root.render(
      <ArtifactComments
        canvasName="c"
        mentionable={[]}
        threads={threads}
        draftAnchor={undefined}
        now={10_000}
        onStart={onStart}
        onReply={() => {}}
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

  it("composes in the mention combobox and starts a thread on the whole artifact", () => {
    const onStart = vi.fn();
    render([], onStart);
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New comment"]')!;
    expect(field.getAttribute("role")).toBe("combobox");
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(field, "looks good");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === "Comment")?.click());
    expect(onStart).toHaveBeenCalledWith("looks good", undefined);
  });
});
