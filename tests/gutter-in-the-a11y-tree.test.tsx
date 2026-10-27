// @vitest-environment jsdom
/**
 * The comment plus is the one control CodeMirror's gutters hold, and the
 * gutters are hidden from assistive tech as a whole. Right after mount, before
 * any typing, the gutter's plus must be findable and the line numbers beside
 * it must stay hidden: in the code editor and in the Markdown field alike
 * (0.11 F7; product-documents' review of the shownCommentGutter plugin).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

const { CodeEditor } = await import("../src/renderer/components/ui/CodeEditor");
const { LiveMarkdownField } = await import("../src/renderer/components/artifacts/LiveMarkdownField");

let root: Root;
let host: HTMLDivElement;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The gutters container, the gutter that holds the plus, and the line numbers' gutter. */
const gutters = (): { readonly container: Element; readonly comment: Element | null; readonly numbers: Element | null } => {
  const container = document.querySelector(".cm-gutters");
  if (container === null) throw new Error("the editor drew no gutters");
  return {
    container,
    comment: container.querySelector(".cm-commentGutter"),
    numbers: container.querySelector(".cm-gutter:not(.cm-commentGutter)"),
  };
};

const expectExposed = (): void => {
  const { container, comment, numbers } = gutters();
  expect(container.getAttribute("aria-hidden")).toBeNull();
  expect(comment).not.toBeNull();
  expect(comment?.getAttribute("aria-hidden")).toBeNull();
  // The code editor draws line numbers beside it; the Markdown field draws none.
  if (numbers !== null) expect(numbers.getAttribute("aria-hidden")).toBe("true");
  // The plus is a named button, which is what a role query and a screen reader find.
  const plus = container.querySelector("[data-testid='file-editor-gutter-comment']");
  expect(plus instanceof HTMLButtonElement).toBe(true);
  expect(plus?.getAttribute("aria-label")).toMatch(/^Comment on lines? \d+/u);
};

describe("the gutter's comment plus in the accessibility tree", () => {
  it("is exposed by the code editor as soon as it opens", async () => {
    await act(async () => root.render(<CodeEditor value={"const a = 1;\nconst b = 2;\n"} path="src/a.ts" onLineComment={() => undefined} />));
    await flush();
    expectExposed();
  });

  it("is exposed by the Markdown field as soon as it opens, and not at all without line comments", async () => {
    await act(async () =>
      root.render(<LiveMarkdownField value={"# A file\n\ntext\n"} label="README.md" onLineComment={() => undefined} />),
    );
    await flush();
    expectExposed();

    await act(async () => root.render(<LiveMarkdownField value={"# A file\n\ntext\n"} label="README.md" />));
    await flush();
    // A document's field takes no line comments: no comment gutter, and the gutters stay as CodeMirror made them.
    expect(document.querySelector(".cm-commentGutter")).toBeNull();
  });
});
