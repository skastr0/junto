// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintItemId } from "../src/shared/resource-command";
import { makeLocalSubjectThreads, newPostOpId, type SubjectThread } from "../src/renderer/lib/subject-threads-source";
import { asNodeId } from "../src/shared/physics/schema";
import { ArtifactComments, ArtifactCommentsEdge } from "../src/renderer/components/artifacts/ArtifactComments";

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

  it("sends on the platform's chord from the table, and never on Control on macOS", async () => {
    const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      const onStart = vi.fn(async () => null);
      render([], onStart);
      const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="New comment"]')!;
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        set.call(field, "looks good");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(field.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
      // Control belongs to the shell on macOS: it is not this comment's chord.
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      });
      expect(onStart).not.toHaveBeenCalled();
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
      });
      expect(onStart).toHaveBeenCalledWith("looks good", undefined);
    } finally {
      if (platform) Object.defineProperty(navigator, "platform", platform);
      else delete (navigator as { platform?: string }).platform;
    }
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

  it("starts a thread per new comment on an artifact, and a reply joins by threadId, as main does", async () => {
    const source = makeLocalSubjectThreads();
    const subject = { kind: "artifact" as const, nodeId: asNodeId("artifacts"), artifactId: mintItemId() };
    const first = await source.post("c", subject, { text: "one", opId: newPostOpId() });
    await source.post("c", subject, { text: "two", opId: newPostOpId() });
    if (!first.ok) throw new Error(first.message);
    await source.post("c", subject, { text: "reply", opId: newPostOpId(), threadId: first.threadId });
    const threads = await source.threads("c", subject);
    expect(threads.map((thread) => thread.posts.map((post) => post.text))).toEqual([["one", "reply"], ["two"]]);
  });
});

describe("artifact comments rail, collapsed", () => {
  const seatPost = (nodeId: string, at: number) => ({
    messageId: mintItemId(),
    author: { kind: "seat" as const, nodeId: asNodeId(nodeId) },
    text: "seen",
    at,
  });

  it("is an edge with the count of every post and the seats that took part, latest first", () => {
    const onOpen = vi.fn();
    const threads: SubjectThread[] = [
      { threadId: mintItemId(), posts: [thread("mine", 1).posts[0]!, seatPost("seat-a", 2)] },
      { threadId: mintItemId(), posts: [seatPost("seat-b", 5), seatPost("seat-a", 3)] },
    ];
    act(() => root.render(<ArtifactCommentsEdge threads={threads} seatName={(id) => id.toUpperCase()} onOpen={onOpen} />));
    const edge = host.querySelector<HTMLButtonElement>("[data-comments-toggle]")!;
    expect(edge.getAttribute("aria-label")).toBe("Comments, 4");
    expect(edge.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="comments-edge-count"]')?.textContent).toBe("4");
    expect([...host.querySelectorAll('[data-testid="comments-edge-seat"]')].map((el) => el.getAttribute("data-seat-id"))).toEqual(["seat-b", "seat-a"]);
    expect(edge.title).toBe("Open comments, from SEAT-B, SEAT-A");
    act(() => edge.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("shows no count and no faces when nothing is written yet", () => {
    act(() => root.render(<ArtifactCommentsEdge threads={[]} onOpen={() => {}} />));
    expect(host.querySelector("[data-comments-toggle]")?.getAttribute("aria-label")).toBe("Comments");
    expect(host.querySelector('[data-testid="comments-edge-count"]')).toBeNull();
    expect(host.querySelector('[data-testid="comments-edge-seat"]')).toBeNull();
  });
});
