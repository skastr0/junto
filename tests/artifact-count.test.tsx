// @vitest-environment jsdom
/** An Artifacts card's count: reads land in order, a change waits behind the read out, and a failed read keeps the last count. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { artifactsSource, setArtifactsSource, useNodeArtifactCount, type ArtifactsSource } from "../src/window/lib/artifacts-source";
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

it("queues a change behind the read out, lands each read in order, and keeps the last count when a read fails", async () => {
  await act(async () => root.render(<Count />));
  // A change while the first read is out waits behind it: one read at a time, never two racing.
  await act(async () => changed!({ canvasName: "work" }));
  expect(reads).toHaveLength(1);

  await act(async () => reads[0]!.resolve(heads(5)));
  expect(host.textContent).toBe("5");
  expect(reads).toHaveLength(2);
  await act(async () => reads[1]!.resolve(heads(2, 1)));
  expect(host.textContent).toBe("2");

  await act(async () => changed!({ canvasName: "work" }));
  expect(reads).toHaveLength(3);
  await act(async () => reads[2]!.reject(new Error("main is gone")));
  expect(host.textContent).toBe("2");
});
