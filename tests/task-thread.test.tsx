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
  type ThreadPostOutcome,
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

describe("a mention of a node that is gone", () => {
  it("draws as the kind its trigger named, a task for # and a seat for @", () => {
    const html = renderToStaticMarkup(
      <ThreadPosts
        threads={[{ threadId: "t", posts: [{ messageId: "m", author: { kind: "operator" }, text: `${mentionLink({ kind: "task", nodeId: asNodeId("tasks-x"), taskId: mintItemId() }, "#9 Old", "factory")} ${mentionLink({ kind: "seat", nodeId: asNodeId("seat-x") }, "@Xan", "factory")}`, at: 1 }] }]}
        now={2}
        seatName={() => undefined}
        nodeKindOf={() => undefined}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-kind="task"');
    expect(html).toContain('data-kind="seat"');
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

describe("the local subject threads, as main puts them", () => {
  const board = asNodeId("tasks-build");
  const art = asNodeId("artifacts-a");
  const task = mintItemId() as TaskId;
  const subject = { kind: "task", nodeId: board, taskId: task } as const;

  it("keeps a task's posts in the thread whose id is the task's, and accepts a thread id it has not seen", async () => {
    const source = makeLocalSubjectThreads();
    const a = await source.post("c", subject, { text: "one", opId: "op1" });
    const b = await source.post("c", subject, { text: "two", opId: "op2" });
    expect(a).toMatchObject({ ok: true, threadId: task });
    expect(b).toMatchObject({ ok: true, threadId: task });
    const named = await source.post("c", subject, { text: "elsewhere", opId: "op3", threadId: "t-other" });
    expect(named).toMatchObject({ ok: true, threadId: "t-other" });
    const threads = await source.threads("c", subject);
    expect(threads.map((thread) => [thread.threadId, thread.posts.length])).toEqual([[task, 2], ["t-other", 1]]);
  });

  it("starts a new thread for each artifact post that names none", async () => {
    const source = makeLocalSubjectThreads();
    const artifact = { kind: "artifact", nodeId: art, artifactId: mintItemId() } as const;
    await source.post("c", artifact, { text: "a", opId: "o1" });
    await source.post("c", artifact, { text: "b", opId: "o2" });
    expect((await source.threads("c", artifact)).map((thread) => thread.posts.length)).toEqual([1, 1]);
  });

  it("answers a replay with the first result, a refusal included, and judges nothing again", async () => {
    const source = makeLocalSubjectThreads();
    const first = await source.post("c", subject, { text: "  ", opId: "same" });
    expect(first).toEqual({ ok: false, message: "Write something to post." });
    expect(await source.post("c", subject, { text: "now with words", opId: "same" })).toEqual(first);
    expect(await source.threads("c", subject)).toEqual([]);
    const posted = await source.post("c", subject, { text: "real", opId: "other" });
    expect(await source.post("c", subject, { text: "real", opId: "other" })).toEqual(posted);
    expect((await source.threads("c", subject))[0]?.posts).toHaveLength(1);
    // The same op id on another subject or canvas is another write.
    expect((await source.post("c2", subject, { text: "x", opId: "other" })).ok).toBe(true);
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

  it("clears what was sent but keeps what was typed while it was in flight", async () => {
    let release: () => void = () => undefined;
    const slow: SubjectThreadsSource = {
      threads: async () => [],
      post: () =>
        new Promise<ThreadPostOutcome>((resolve) => {
          release = () => resolve({ ok: true, threadId: "t", messageId: "m" });
        }),
      subscribe: () => () => undefined,
    };
    setSubjectThreadsSource(slow);
    await mount();
    const field = await typeInto("First");
    await enter(field);
    await typeInto("First and more");
    await act(async () => release());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on this task"]')!.value).toBe("First and more");
  });

  it("recovers when the post throws: the button works again and the text stays", async () => {
    const broken: SubjectThreadsSource = {
      threads: async () => [],
      post: vi.fn(async () => {
        throw new Error("The bridge dropped.");
      }),
      subscribe: () => () => undefined,
    };
    setSubjectThreadsSource(broken);
    await mount();
    await typeInto("Please");
    const button = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Comment")!;
    await act(async () => button().click());
    expect(host.querySelector('[data-testid="task-thread-failure"]')?.textContent).toBe("The bridge dropped.");
    expect(button().disabled).toBe(false);
  });

  it("sends one op id per post: a retry of the same text reuses it, other text gets its own", async () => {
    const seen: string[] = [];
    let refuse = true;
    const flaky: SubjectThreadsSource = {
      threads: async () => [],
      post: async (_c, _s, post) => {
        seen.push(post.opId);
        return refuse ? { ok: false, message: "Out of reach." } : { ok: true, threadId: "t", messageId: "m" };
      },
      subscribe: () => () => undefined,
    };
    setSubjectThreadsSource(flaky);
    await mount();
    const field = await typeInto("Same words");
    await enter(field);
    await act(async () => undefined);
    await enter(field);
    await act(async () => undefined);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    await typeInto("Different words");
    await enter(host.querySelector('textarea[aria-label="Comment on this task"]')!);
    await act(async () => undefined);
    expect(seen[2]).not.toBe(seen[0]);
    refuse = false;
    await enter(host.querySelector('textarea[aria-label="Comment on this task"]')!);
    await act(async () => undefined);
    expect(seen[3]).toBe(seen[2]);
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
