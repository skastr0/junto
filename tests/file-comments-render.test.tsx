// @vitest-environment jsdom
/**
 * A file's comments in the Files modal (0.11 F7): the rail lists only the open
 * file's threads, names each by where it hangs now, and shows the lines it
 * hangs on, so a thread on line 10 says line 12 once two lines are typed above
 * it. A box thread shows on the picture it was drawn on.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import { parseFilePath, ROOT_PATH } from "../src/shared/files";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has none, and the editor's rows measure themselves with one.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

const { FilesNode } = await import("../src/renderer/components/files/FilesNode");
const { installFilesSource, makeLocalFiles, setFileDraft, fileDraft } = await import("../src/renderer/lib/files-source");
const { setSubjectThreadsSource } = await import("../src/renderer/lib/subject-threads-source");
// The viewers are lazily imported by FileView; warming the chunk keeps the
// first paint from being the suspense fallback inside act().
await import("../src/renderer/components/file-view/ImageViewer");

const nodeId = asNodeId("files-comments-render");
const canvasName = "c";
const BIG = parseFilePath("src/big.ts")!;
const PICTURE = parseFilePath("img/gradient.png")!;

const BIG_TEXT = Array.from({ length: 14 }, (_, index) => (index === 9 ? "export const row1 = 1;" : `// line ${String(index + 1)}`)).join("\n");

let root: Root;
let host: HTMLDivElement;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    // The viewers are lazily imported: give the chunk a turn of the loop too.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const openRail = async (): Promise<void> => {
  const edge = document.querySelector(".artifact-comments-edge");
  await act(async () => (edge as HTMLElement | null)?.click());
  await flush();
};

/** The rail's threads: the list is an ordered list named Threads, as the rail draws it. */
const threadRows = (): ReadonlyArray<Element> => [...document.querySelectorAll("ol[aria-label='Threads'] > li")];

/** A thread on lines 10..10 of src/big.ts, quoting its line. */
const sourceWithLineThread = () =>
  setSubjectThreadsSource({
    threads: async (_canvas, subject) =>
      subject.kind === "file" && subject.path === BIG
        ? [
            {
              threadId: "thread-1",
              anchor: { kind: "lines", file: BIG, from: 10, to: 10, quote: "export const row1 = 1;" },
              posts: [{ messageId: "m1", author: { kind: "operator" }, text: "check the row id", at: 1 }],
            },
          ]
        : [],
    post: async () => ({ ok: false, message: "not in this test" }),
    subscribe: () => () => undefined,
  });

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFileDraft(nodeId, BIG, undefined);
  installFilesSource(null);
  setSubjectThreadsSource({ threads: async () => [], post: async () => ({ ok: false, message: "" }), subscribe: () => () => undefined });
});

const render = async (path = BIG): Promise<void> => {
  await act(async () => root.render(<FilesNode canvasName={canvasName} nodeId={nodeId} initialPath={path} onClose={() => undefined} />));
  // Twice: a viewer is lazily imported, and its first render lands after the chunk.
  await flush();
  await flush();
};

describe("a file's comments in the Files modal", () => {
  it("lists the open file's thread where its lines are now, and shows the lines it quoted", async () => {
    installFilesSource(makeLocalFiles({ "src/big.ts": BIG_TEXT, "img/gradient.png": { size: 40 } }));
    sourceWithLineThread();
    await render();
    await openRail();
    expect(threadRows()).toHaveLength(1);
    expect(threadRows()[0]?.textContent).toContain("Line 10");
    expect(threadRows()[0]?.textContent).toContain("check the row id");
    expect(threadRows()[0]?.textContent).toContain("export const row1 = 1;");
  });

  it("names the line a thread moved to once text is typed above it", async () => {
    const files = makeLocalFiles({ "src/big.ts": BIG_TEXT });
    installFilesSource(files);
    sourceWithLineThread();
    await render();
    const read = await files.read({ canvas: canvasName, node: nodeId }, BIG);
    if (!read.ok || read.value.kind !== "text") throw new Error("expected text");
    await act(async () => setFileDraft(nodeId, BIG, { text: `// added one\n// added two\n${BIG_TEXT}`, base: read.value.stamp }));
    await flush();
    await openRail();
    expect(threadRows()[0]?.textContent).toContain("Line 12");
    expect(fileDraft(nodeId, BIG)?.text.startsWith("// added one")).toBe(true);
  });

  it("puts the gutter's pressed line in the composer, and posts the comment on it with its quote", async () => {
    installFilesSource(makeLocalFiles({ "src/big.ts": BIG_TEXT }));
    const posts: Array<{ text: string; anchor?: unknown }> = [];
    setSubjectThreadsSource({
      threads: async () => [],
      post: async (_canvas, subject, post) => {
        if (subject.kind === "file") posts.push({ text: post.text, ...(post.anchor === undefined ? {} : { anchor: post.anchor }) });
        return { ok: true, threadId: "t1", messageId: "m1" };
      },
      subscribe: () => () => undefined,
    });
    await render();
    // The editor's caret is on line 1 when it opens, and the plus shows beside it.
    const plus = document.querySelector("[data-testid='file-editor-gutter-comment']");
    expect(plus?.getAttribute("aria-label")).toBe("Comment on line 1");
    await act(async () => (plus as HTMLElement).click());
    await flush();
    await openRail();
    expect(document.querySelector(".artifact-comments__anchor")?.textContent).toContain("On Line 1");
    const field = document.querySelector("[aria-label='New comment']") as HTMLTextAreaElement | null;
    if (field === null) throw new Error("no composer");
    const typed = "the header line";
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(field, typed);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const send = [...document.querySelectorAll("button")].find((button) => button.textContent === "Comment");
    await act(async () => send?.click());
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toBe(typed);
    expect(posts[0]?.anchor).toEqual({ kind: "lines", file: "src/big.ts", from: 1, to: 1, quote: "// line 1" });
  });

  it("keeps one file's threads out of another's rail", async () => {
    installFilesSource(makeLocalFiles({ "src/big.ts": BIG_TEXT, "README.md": "# Files\n" }));
    sourceWithLineThread();
    await render(parseFilePath("README.md")!);
    await openRail();
    expect(threadRows()).toHaveLength(0);
  });

  it("says where the composer's comment is going, and offers the whole file again", async () => {
    installFilesSource(makeLocalFiles({ "src/big.ts": BIG_TEXT }));
    setSubjectThreadsSource({
      threads: async () => [],
      post: async () => ({ ok: true, threadId: "t", messageId: "m" }),
      subscribe: () => () => undefined,
    });
    await render();
    await openRail();
    expect(document.querySelector("[aria-label='New comment']")).not.toBeNull();
    expect(document.body.textContent).toContain("On Whole file");
  });

  it("names a box on a PDF page by its page, and a box on an image by the image", async () => {
    installFilesSource(makeLocalFiles({ "docs/brief.pdf": { size: 40 } }));
    setSubjectThreadsSource({
      threads: async () => [
        {
          threadId: "thread-page",
          anchor: { kind: "pageBox", page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          posts: [{ messageId: "m3", author: { kind: "operator" }, text: "the heading", at: 1 }],
        },
      ],
      post: async () => ({ ok: false, message: "not in this test" }),
      subscribe: () => () => undefined,
    });
    await render(parseFilePath("docs/brief.pdf")!);
    await openRail();
    expect(threadRows()[0]?.textContent).toContain("Area on page 1");
  });

  it("draws a thread's box on the picture it was drawn on", async () => {
    installFilesSource(makeLocalFiles({ "src/big.ts": BIG_TEXT, "img/gradient.png": { size: 40 } }));
    setSubjectThreadsSource({
      threads: async (_canvas, subject) =>
        subject.kind === "file" && subject.path === PICTURE
          ? [
              {
                threadId: "thread-box",
                anchor: { kind: "pageBox", page: 1, x: 0.25, y: 0.2, w: 0.5, h: 0.4 },
                posts: [{ messageId: "m2", author: { kind: "operator" }, text: "the gradient corner", at: 1 }],
              },
            ]
          : [],
      post: async () => ({ ok: false, message: "not in this test" }),
      subscribe: () => () => undefined,
    });
    await render(PICTURE);
    expect(document.querySelectorAll("[data-testid='file-box-thread']")).toHaveLength(1);
    await openRail();
    expect(threadRows()[0]?.textContent).toContain("Area on the image");
    expect(threadRows()[0]?.textContent).toContain("the gradient corner");
    // A root read never names an absolute path: the rail is the file's own.
    expect(ROOT_PATH).toBe("");
  });
});
