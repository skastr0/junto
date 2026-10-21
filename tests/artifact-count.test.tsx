// @vitest-environment jsdom
/** An Artifacts card's count: only the newest read lands, and a failed read keeps the last count. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { artifactsSource, setArtifactsSource, useNodeArtifactCount, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import type { NodeId } from "../src/shared/physics/schema";

type Read = { readonly resolve: (heads: ReadonlyArray<ArtifactHead>) => void; readonly reject: (error: Error) => void };

const original = artifactsSource();
let reads: Read[];
let changed: ((change: { readonly canvasName: string }) => void) | undefined;
let host: HTMLDivElement;
let root: Root;

const heads = (live: number, archived = 0): ReadonlyArray<ArtifactHead> =>
  Array.from({ length: live + archived }, (_, index) => ({ artifact: { archived: index >= live } }) as unknown as ArtifactHead);

function Count() {
  return <span>{useNodeArtifactCount("work", "art-1" as NodeId, true)}</span>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads = [];
  setArtifactsSource({
    ...original,
    list: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    onChanged: (listener: (change: { readonly canvasName: string }) => void) => {
      changed = listener;
      return () => (changed = undefined);
    },
  } as unknown as ArtifactsSource);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  setArtifactsSource(original);
  vi.unstubAllGlobals();
});

it("keeps the newest count when two reads resolve out of order, and the last count when a read fails", async () => {
  await act(async () => root.render(<Count />));
  await act(async () => changed!({ canvasName: "work" }));
  expect(reads).toHaveLength(2);

  await act(async () => reads[1]!.resolve(heads(2, 1)));
  expect(host.textContent).toBe("2");
  await act(async () => reads[0]!.resolve(heads(5)));
  expect(host.textContent).toBe("2");

  await act(async () => changed!({ canvasName: "work" }));
  await act(async () => reads[2]!.reject(new Error("main is gone")));
  expect(host.textContent).toBe("2");
});
