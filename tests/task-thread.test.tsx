// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mentionLink } from "../src/shared/mention";
import { asNodeId } from "../src/shared/model";
import { mintItemId } from "../src/shared/resource-command";
import { taskNodeId, type TaskId } from "../src/shared/task-model";
import { mentionLabelKind } from "../src/renderer/components/tasks/mention-chip";
import { textPieces } from "../src/renderer/components/tasks/mention-text";
import { TaskThread, ThreadPosts } from "../src/renderer/components/tasks/TaskThread";
import {
  makeLocalSubjectThreads,
  setSubjectThreadsSource,
  type SubjectThreadsSource,
} from "../src/renderer/lib/subject-threads-source";

const ada = asNodeId("seat-ada");
const board = asNodeId("tasks-build");
const kinds = (id: string) => (id === "seat-ada" ? "agent" : id === "tasks-build" ? "task" : undefined) as never;

describe("textPieces", () => {
  it("splits words from mentions and marks a mention of a node that is gone", () => {
    const link = mentionLink({ kind: "seat", nodeId: ada }, "@Ada", "factory");
    const gone = mentionLink({ kind: "seat", nodeId: asNodeId("seat-x") }, "@Xan", "factory");
    const pieces = textPieces(`Ask ${link} then ${gone}, thanks`, kinds);
    expect(pieces.map((piece) => piece.kind)).toEqual(["text", "mention", "text", "gone", "text"]);
    expect(pieces[1]).toMatchObject({ kind: "mention", ref: { kind: "seat", nodeId: ada }, label: "@Ada" });
    expect(pieces[3]).toMatchObject({ kind: "gone", label: "@Xan" });
    expect(textPieces("plain", kinds)).toEqual([{ kind: "text", text: "plain" }]);
  });
});

describe("mentionLabelKind", () => {
  it("drops the @ or # the chip adds and pulls a task's number out of its label", () => {
    expect(mentionLabelKind({ kind: "seat", nodeId: ada }, "@Ada")).toEqual({ kind: "seat", label: "Ada" });
    const task = { kind: "task", nodeId: board, taskId: mintItemId() } as const;
    expect(mentionLabelKind(task, "#42 Fix tabs")).toEqual({ kind: "task", label: "Fix tabs", number: 42 });
    expect(mentionLabelKind(task, "#Fix tabs")).toEqual({ kind: "task", label: "Fix tabs" });
  });
});

describe("ThreadPosts", () => {
  const post = (text: string, at: number) => ({ messageId: `m${at}`, author: { kind: "operator" } as const, text, at });

  it("says so when nothing was said", () => {
    const html = renderToStaticMarkup(<ThreadPosts threads={[]} now={1} seatName={() => undefined} nodeKindOf={kinds} onOpen={() => undefined} />);
    expect(html).toContain("No comments yet.");
  });

  it("lists posts oldest first with who and when, and draws a mention as a chip that opens", () => {
    const link = mentionLink({ kind: "seat", nodeId: ada }, "@Ada", "factory");
    const html = renderToStaticMarkup(
      <ThreadPosts
        threads={[{ threadId: "t", posts: [post(`Second, over to ${link}`, 2_000), post("First", 1_000)] }]}
        now={61_000}
        seatName={() => "Ada"}
        nodeKindOf={kinds}
        onOpen={() => undefined}
      />,
    );
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html).toContain("You");
    expect(html).toContain("@Ada");
    expect(html).toMatch(/<button[^>]*class="resource-chip"/);
  });
});

describe("TaskThread", () => {
  let host: HTMLDivElement;
  let root: Root;
  const taskId = mintItemId() as TaskId;
  const mount = async () => {
    await act(async () => {
      root.render(<TaskThread canvasName="factory" node={taskNodeId(board)} taskId={taskId} all={[]} now={5_000} seatName={() => undefined} />);
    });
  };
  const typeInto = async (value: string) => {
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on this task"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return field;
  };
  const enter = async (field: Element) => {
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("posts on Enter, clears the field and lists the comment; Shift+Enter does not send", async () => {
    setSubjectThreadsSource(makeLocalSubjectThreads());
    await mount();
    const field = await typeInto("Needs a second look");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(host.querySelectorAll('[data-testid="task-thread-post"]')).toHaveLength(0);
    await enter(field);
    await act(async () => undefined);
    expect(host.querySelectorAll('[data-testid="task-thread-post"]')).toHaveLength(1);
    expect(host.textContent).toContain("Needs a second look");
    expect(host.textContent).toContain("Comments, 1");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on this task"]')!.value).toBe("");
  });

  it("keeps the text and says why when the post is refused", async () => {
    const refusing: SubjectThreadsSource = {
      threads: async () => [],
      post: vi.fn(async () => ({ ok: false, message: "Ada is not in reach of this task." }) as const),
      subscribe: () => () => undefined,
    };
    setSubjectThreadsSource(refusing);
    await mount();
    const field = await typeInto("Over to Ada");
    await enter(field);
    await act(async () => undefined);
    expect(host.querySelector('[data-testid="task-thread-failure"]')?.textContent).toBe("Ada is not in reach of this task.");
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on this task"]')!.value).toBe("Over to Ada");
  });
});
