// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactLabel } from "../src/shared/artifact-labels";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import { keptArtifactsFilter, labelsStillHeld, useKeptArtifactsFilter } from "../src/renderer/lib/artifacts-filter-kept";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = (...labels: string[]) => labels as unknown as ReadonlyArray<ArtifactLabel>;
const head = (title: string, labels: ReadonlyArray<string>): ArtifactHead =>
  ({ artifact: { artifactId: title, title, type: "document", labels, archived: false } }) as unknown as ArtifactHead;
const entries = [head("Release", ["project/junto/release", "draft"]), head("Web", ["project/junto/web"])];

let host: HTMLDivElement;
let root: Root;
let seen: ReturnType<typeof useKeptArtifactsFilter>;

function Probe({ canvas, node, list }: { readonly canvas: string; readonly node: string; readonly list: ReadonlyArray<ArtifactHead> }) {
  seen = useKeptArtifactsFilter(canvas, node, list);
  return null;
}
const open = (node: string, list: ReadonlyArray<ArtifactHead> = entries, canvas = "c") =>
  act(() => root.render(<Probe key={node} canvas={canvas} node={node} list={list} />));
const close = () => act(() => root.render(null));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the Artifacts node's kept filter", () => {
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

  it("reads held labels against the node's artifacts", () => {
    expect(labelsStillHeld(L("draft", "project", "nope"), entries)).toEqual(["draft", "project"]);
  });
});
