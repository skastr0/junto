// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { ArtifactVersion, TextPatch } from "../src/shared/artifact";
import { DocumentEditor } from "../src/renderer/components/artifacts/DocumentEditor";
import { postAfterSave } from "../src/renderer/components/artifacts/artifacts-pane-model";

let root: Root;
let host: HTMLDivElement;

const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
const type = async (text: string) => {
  const view = editor();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" }));
};
const selectText = async (quote: string) => {
  const view = editor();
  const start = view.state.doc.toString().indexOf(quote);
  await act(async () => view.dispatch({ selection: { anchor: start, head: start + quote.length }, userEvent: "select" }));
};
const commentButton = () =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Comment on selection"))!;

const mount = async (onPatch: (base: ArtifactVersion, patches: ReadonlyArray<TextPatch>) => Promise<string | null>) => {
  let save: (() => Promise<string | null>) | null = null;
  const onCommentText = vi.fn((_quote: string, _offset: number, next: () => Promise<string | null>) => {
    save = next;
  });
  await act(async () =>
    root.render(
      <DocumentEditor
        body={{ type: "document", markdown: "Ship it" }}
        version={1 as ArtifactVersion}
        onPatch={onPatch}
        onCommentText={onCommentText}
      />,
    ),
  );
  return { onCommentText, save: () => save!() };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("hands a selection its save, which sends typing still resting before the comment posts", async () => {
  const onPatch = vi.fn(async (_base: ArtifactVersion, _patches: ReadonlyArray<TextPatch>): Promise<string | null> => null);
  const { onCommentText, save } = await mount(onPatch);
  await type("Ship the tabs today");
  await selectText("tabs today");
  await act(async () => commentButton().click());
  expect(onCommentText).toHaveBeenCalledWith("tabs today", 9, expect.any(Function));
  expect(onPatch).not.toHaveBeenCalled();

  expect(await save()).toBeNull();
  expect(onPatch).toHaveBeenCalledTimes(1);
  expect(onPatch.mock.calls[0]?.[0]).toBe(1);
  // Nothing left unsent: a second save sends nothing.
  expect(await save()).toBeNull();
  expect(onPatch).toHaveBeenCalledTimes(1);
});

it("resolves the save to the refusal when the document is not saved", async () => {
  const onPatch = vi.fn(async () => "written against version 1, the head is 2");
  const { save } = await mount(onPatch);
  await type("Ship the tabs today");
  await selectText("tabs");
  await act(async () => commentButton().click());
  let refused: string | null = null;
  await act(async () => {
    refused = await save();
  });
  expect(refused).toBe("written against version 1, the head is 2");
  expect(host.textContent).toContain("Overwrite theirs");
});

it("keeps saving after a send that failed to reach Junto", async () => {
  const onPatch = vi
    .fn<(base: ArtifactVersion, patches: ReadonlyArray<TextPatch>) => Promise<string | null>>()
    .mockRejectedValueOnce(new Error("ipc down"))
    .mockResolvedValue(null);
  const { save } = await mount(onPatch);
  await type("Ship the tabs today");
  await selectText("tabs");
  await act(async () => commentButton().click());
  await expect(save()).rejects.toThrow("ipc down");
  expect(await save()).toBeNull();
  expect(onPatch).toHaveBeenCalledTimes(2);
});

it("spends the save once the editor is gone, so an old draft is never resent", async () => {
  const onPatch = vi.fn(async (_base: ArtifactVersion, _patches: ReadonlyArray<TextPatch>): Promise<string | null> => "written against version 1, the head is 2");
  const { save } = await mount(onPatch);
  await type("Ship the tabs today");
  await selectText("tabs");
  await act(async () => commentButton().click());
  // Closing sends the resting draft once.
  await act(async () => root.render(null));
  expect(onPatch).toHaveBeenCalledTimes(1);
  expect(await save()).toBeNull();
  expect(onPatch).toHaveBeenCalledTimes(1);
});

const anchorText = { kind: "text", quote: "tabs" } as const;

it("posts a text-anchored comment only after the document saves", async () => {
  const order: string[] = [];
  const save = vi.fn(async () => (order.push("save"), null));
  const post = vi.fn(async () => (order.push("post"), null));
  expect(await postAfterSave(anchorText, save, post)).toBeNull();
  expect(order).toEqual(["save", "post"]);
});

it("stops the post when the save is refused or fails, and says why", async () => {
  const post = vi.fn(async () => null);
  expect(await postAfterSave(anchorText, async () => "written against version 1, the head is 2", post)).toBe(
    "Not posted: the document did not save (written against version 1, the head is 2). Choose Overwrite theirs or Take theirs above, then post again.",
  );
  expect(await postAfterSave(anchorText, () => Promise.reject(new Error("ipc down")), post)).toBe(
    "Not posted: the document could not be saved. Try again.",
  );
  expect(post).not.toHaveBeenCalled();
});

it("posts a whole, cells or unanchored comment without saving", async () => {
  const save = vi.fn(async () => "refused");
  const post = vi.fn(async () => null);
  await postAfterSave(undefined, save, post);
  await postAfterSave({ kind: "whole" }, save, post);
  await postAfterSave({ kind: "cells", range: "B2" }, save, post);
  await postAfterSave(anchorText, null, post);
  expect(save).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledTimes(4);
});

it("takes a new head into the surface without sending it back", async () => {
  const onPatch = vi.fn(async (): Promise<string | null> => null);
  await mount(onPatch);
  await act(async () =>
    root.render(<DocumentEditor body={{ type: "document", markdown: "Ship it today" }} version={2 as ArtifactVersion} onPatch={onPatch} />),
  );
  expect(editor().state.doc.toString()).toBe("Ship it today");
  expect(onPatch).not.toHaveBeenCalled();
});

it("draws a read-only version with nothing to type into and no tabs", async () => {
  await act(async () =>
    root.render(
      <DocumentEditor body={{ type: "document", markdown: "# Old" }} version={1 as ArtifactVersion} readOnly onPatch={async () => null} />,
    ),
  );
  expect(editor().contentDOM.getAttribute("contenteditable")).toBe("false");
  expect(host.textContent).not.toMatch(/Split|Write/u);
});
