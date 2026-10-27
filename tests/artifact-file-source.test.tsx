// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileBody, FileSource } from "../src/shared/artifact";
import type { ContentRef } from "../src/shared/content";
import type { NodeId } from "../src/shared/physics/schema";
import { FilePreview, fileSourceLine } from "../src/renderer/components/artifacts/ArtifactPreview";

vi.mock("../src/renderer/components/work/ContentMedia", () => ({ ContentMedia: () => null }));

let root: Root;
let host: HTMLDivElement;

const content = { sha256: "0".repeat(64), byteLength: 2048, mediaType: "image/png", displayName: "spec, page 2.png" } as unknown as ContentRef;
const source: FileSource = { nodeId: "files-1" as NodeId, path: "docs/spec.pdf", page: 2, box: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } };
const body = (withSource: boolean): FileBody => ({ type: "file", content, ...(withSource ? { source } : {}) });

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

it("says a source by its relative path, and its page when it has one", () => {
  expect(fileSourceLine(source)).toBe("From docs/spec.pdf, page 2");
  const { page: _page, ...image } = source;
  expect(fileSourceLine(image)).toBe("From docs/spec.pdf");
});

it("names no source for a file that has none", async () => {
  await act(async () => root.render(<FilePreview body={body(false)} onOpenSource={() => undefined} />));
  expect(host.querySelector(".artifact-preview__source")).toBeNull();
});

it("shows the source as words when its Files node is out of reach", async () => {
  await act(async () => root.render(<FilePreview body={body(true)} />));
  const line = host.querySelector(".artifact-preview__source");
  expect(line?.tagName).toBe("P");
  expect(line?.textContent).toBe("From docs/spec.pdf, page 2");
});

it("opens the source when its Files node is in reach", async () => {
  const opened: FileSource[] = [];
  await act(async () => root.render(<FilePreview body={body(true)} onOpenSource={(at) => opened.push(at)} />));
  const button = host.querySelector<HTMLButtonElement>("button.artifact-preview__source");
  expect(button?.textContent).toBe("From docs/spec.pdf, page 2");
  expect(button?.getAttribute("aria-label")).toBe("From docs/spec.pdf, page 2, open in its Files node");
  await act(async () => button!.click());
  expect(opened).toEqual([source]);
});
