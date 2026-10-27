// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeWorkDetailOpen,
  filesDetailOpening,
  openWorkDetail,
  useFollowOpen,
} from "../src/renderer/lib/work-detail-open";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A detail surface as Artifacts, Tasks and Files are: one selection, set by an open or by a pick inside. */
let pick: (id: string) => void = () => undefined;
function Surface({ initialItemId, openKey }: { readonly initialItemId?: string; readonly openKey?: number }) {
  const [selected, setSelected] = useState<string | null>(initialItemId ?? null);
  pick = setSelected;
  useFollowOpen(initialItemId, openKey, setSelected);
  return <p data-selected={selected ?? ""} />;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

/** What TextNode does with a consumed open: hand the item and the open's number to the surface. */
let lastOpen = 0;
const follow = (nodeId: string, itemId: string): void => {
  openWorkDetail(nodeId, { itemId });
  const opening = filesDetailOpening(consumeWorkDetailOpen(nodeId)!);
  lastOpen = opening.openKey;
  act(() => root.render(<Surface {...(opening.initialItemId === undefined ? {} : { initialItemId: opening.initialItemId })} openKey={opening.openKey} />));
};
const selected = (): string | null | undefined => host.querySelector("p")?.getAttribute("data-selected");

describe("every open through openWorkDetail is its own", () => {
  it("numbers two opens of the same item apart", () => {
    openWorkDetail("art", { itemId: "x" });
    const first = consumeWorkDetailOpen("art")!;
    openWorkDetail("art", { itemId: "x" });
    const second = consumeWorkDetailOpen("art")!;
    expect(first.itemId).toBe(second.itemId);
    expect(second.open).not.toBe(first.open);
  });

  it("lands on the linked item after a switch inside the surface, and again on a second open of it", () => {
    follow("art", "x");
    expect(selected()).toBe("x");
    act(() => pick("y"));
    expect(selected()).toBe("y");
    follow("art", "x");
    expect(selected()).toBe("x");
    act(() => pick("y"));
    follow("art", "x");
    expect(selected()).toBe("x");
  });

  it("leaves a pick inside the surface alone until the next open", () => {
    follow("art", "x");
    act(() => pick("y"));
    // A render that is not an open (the canvas re-rendering the node) keeps the same number.
    act(() => root.render(<Surface initialItemId="x" openKey={lastOpen} />));
    expect(selected()).toBe("y");
  });
});
