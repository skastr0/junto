// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactLabel } from "../src/shared/artifact-labels";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import { labelsStillHeld, useArtifactsNodeView } from "../src/renderer/lib/artifacts-node-view";
import { nodeViewStore, setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = (...labels: string[]) => labels as unknown as ReadonlyArray<ArtifactLabel>;
const head = (title: string, labels: ReadonlyArray<string>): ArtifactHead =>
  ({ artifact: { artifactId: title, title, type: "document", labels, archived: false } }) as unknown as ArtifactHead;
const entries = [head("Release", ["project/junto/release", "draft"]), head("Web", ["project/junto/web"])];

let host: HTMLDivElement;
let root: Root;
let seen: ReturnType<typeof useArtifactsNodeView>;
/** What the store holds for a node, as the old kept read gave it. */
const keptArtifactsFilter = (canvas: string, node: string) => {
  const view = nodeViewStore().artifacts(canvas, node);
  return { type: view?.type ?? "all", labels: view?.labels ?? [] };
};

function Probe({ canvas, node, list }: { readonly canvas: string; readonly node: string; readonly list: ReadonlyArray<ArtifactHead> }) {
  seen = useArtifactsNodeView(canvas, node, list);
  return null;
}
const open = (node: string, list: ReadonlyArray<ArtifactHead> = entries, canvas = "c") =>
  act(() => root.render(<Probe key={node} canvas={canvas} node={node} list={list} />));
const close = () => act(() => root.render(null));

beforeEach(() => {
  setNodeViewStore(makeMemoryNodeViewStore());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the Artifacts node's kept view", () => {
  it("keeps the archived toggle and the open artifact beside the filter, per node, in the store", () => {
    open("kept-open");
    expect([seen.archived, seen.open]).toEqual([false, null]);
    act(() => {
      seen.setArchived(true);
      seen.setOpen("Release");
    });
    close();
    open("kept-open");
    expect([seen.archived, seen.open]).toEqual([true, "Release"]);
    expect(nodeViewStore().artifacts("c", "kept-open")).toEqual({ type: "all", archived: true, labels: [], open: "Release" });
    open("kept-other");
    expect([seen.archived, seen.open]).toEqual([false, null]);
  });

  it("hears a change another window writes", () => {
    open("kept-push");
    act(() => nodeViewStore().writeArtifacts("c", "kept-push", { type: "pad", archived: false, labels: [], open: null }));
    expect(seen.type).toBe("pad");
  });

  it("keeps the type and the picked labels across a close and a reopen, per node", () => {
    open("kept-a");
    expect(seen.type).toBe("all");
    act(() => {
      seen.setType("sheet");
      seen.setLabels(() => L("draft", "project/junto"));
    });
    close();
    open("kept-a");
    expect(seen.type).toBe("sheet");
    expect(seen.labels).toEqual(["draft", "project/junto"]);
    open("kept-b");
    expect([seen.type, seen.labels]).toEqual(["all", []]);
    expect(keptArtifactsFilter("other canvas", "kept-a")).toEqual({ type: "all", labels: [] });
  });

  it("drops a picked label no artifact carries any more, a level staying while a label under it does", () => {
    open("kept-drop");
    act(() => seen.setLabels(() => L("draft", "gone", "project/junto")));
    expect(seen.labels).toEqual(["draft", "project/junto"]);
    close();
    open("kept-drop", [head("Web", ["project/junto/web"])]);
    expect(seen.labels).toEqual(["project/junto"]);
    expect(keptArtifactsFilter("c", "kept-drop").labels).toEqual(["project/junto"]);
  });

  it("holds the picks while the list has not arrived", () => {
    open("kept-wait");
    act(() => seen.setLabels(() => L("draft")));
    close();
    open("kept-wait", []);
    expect(seen.labels).toEqual(["draft"]);
    open("kept-wait");
    expect(seen.labels).toEqual(["draft"]);
  });

  it("reads the new node's filter when the node changes under a mounted modal, and keeps none for an unnamed canvas", () => {
    const at = (canvas: string, node: string) => act(() => root.render(<Probe canvas={canvas} node={node} list={entries} />));
    at("c", "moved-a");
    act(() => seen.setType("pad"));
    at("c", "moved-b");
    expect(seen.type).toBe("all");
    act(() => seen.setLabels(() => L("draft")));
    expect(keptArtifactsFilter("c", "moved-a").type).toBe("pad");
    expect(keptArtifactsFilter("c", "moved-b")).toEqual({ type: "all", labels: ["draft"] });
    at("", "moved-c");
    act(() => seen.setType("sheet"));
    expect(keptArtifactsFilter("", "moved-c")).toEqual({ type: "all", labels: [] });
    at("c", "moved-a");
    expect(seen.type).toBe("pad");
  });

  it("reads held labels against the node's artifacts", () => {
    expect(labelsStillHeld(L("draft", "project", "nope"), entries)).toEqual(["draft", "project"]);
  });
});
