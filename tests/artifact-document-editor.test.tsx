// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactVersion, TextPatch } from "../src/shared/artifact";
import { DocumentEditor } from "../src/renderer/components/artifacts/DocumentEditor";

let root: Root;
let host: HTMLDivElement;

const source = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown"]')!;
const type = async (text: string) => {
  const el = source();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
  await act(async () => el.dispatchEvent(new Event("input", { bubbles: true })));
};
const selectText = async (quote: string) => {
  const el = source();
  const start = el.value.indexOf(quote);
  // React synthesizes onSelect from a mouseup on the focused field.
  el.focus();
  el.setSelectionRange(start, start + quote.length);
  await act(async () => el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
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
