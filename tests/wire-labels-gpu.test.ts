// @vitest-environment jsdom
/**
 * The wire select targets follow the camera as one wrapper (shell/wire-labels.ts).
 *
 * The engine draws frames continuously (a seat ring keeps the loop running),
 * and this module is a frame listener. A `getBoundingClientRect()` and a
 * style write per button on every frame is what made a pan expensive: each
 * frame forced style and layout and rewrote hundreds of buttons. These tests
 * lock the shape that replaced it. The canvas box is measured on layout
 * changes only; the wrapper carries the camera in one transform; a button's
 * own style changes only when its wire's geometry does; a resting frame
 * writes nothing and reads no layout.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mountWireLabels, type WireLabels } from "../src/window/canvas/shell/wire-labels";
import type { WiresLayer } from "../src/window/canvas/engine/wires";

type Label = {
  readonly id: string;
  readonly at: { readonly x: number; readonly y: number };
  readonly verb: string;
};

const page = (left: number, top: number): DOMRect =>
  ({
    left,
    top,
    x: left,
    y: top,
    width: 900,
    height: 600,
    right: left + 900,
    bottom: top + 600,
    toJSON: () => ({}),
  }) as DOMRect;

const LABEL = (id: string, x: number, y: number): Label => ({ id, at: { x, y }, verb: "messages" });

/** A wire layer with the two facts this module reads, and the calls counted. */
const world = (labels: ReadonlyArray<Label>) => {
  let revision = 1;
  let listed = labels;
  const calls = { labelsInView: 0, labelsRevision: 0 };
  const layer = {
    labelsInView: (): ReadonlyArray<Label> => {
      calls.labelsInView += 1;
      return listed;
    },
    labelsRevision: (): number => {
      calls.labelsRevision += 1;
      return revision;
    },
  } as unknown as WiresLayer;
  return {
    calls,
    layer: () => layer,
    /** The camera moved: the same wires, a different set of them in view. */
    seen: (next: ReadonlyArray<Label>): void => {
      listed = next;
    },
    /** The wires moved: their label points changed under the camera. */
    moved: (next: ReadonlyArray<Label>): void => {
      listed = next;
      revision += 1;
    },
  };
};

const mounted: WireLabels[] = [];

afterEach(() => {
  for (const wire of mounted.splice(0)) wire.dispose();
  document.body.innerHTML = "";
});

const mount = (wires: ReturnType<typeof world>, canvas: HTMLCanvasElement): WireLabels => {
  const labels = mountWireLabels({ canvas, layer: wires.layer });
  mounted.push(labels);
  return labels;
};

const canvasAt = (box: { left: number; top: number }) => {
  const canvas = document.createElement("canvas");
  const reads = { count: 0 };
  canvas.getBoundingClientRect = () => {
    reads.count += 1;
    return page(box.left, box.top);
  };
  return { canvas, reads };
};

const hostNow = (): HTMLElement => {
  const host = document.querySelector<HTMLElement>('[data-canvas-overlay="wire-labels"]');
  expect(host).not.toBeNull();
  return host as HTMLElement;
};

const buttonsNow = (): ReadonlyArray<HTMLButtonElement> => [...hostNow().querySelectorAll("button")];

const BOARD_AT = (x: number, y: number): string =>
  `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(var(--wire-label-scale, 1))`;

describe("wire select labels on the GPU canvas", () => {
  it("pans by one wrapper transform, and a resting frame writes nothing", () => {
    const { canvas, reads } = canvasAt({ left: 100, top: 40 });
    const wires = world([LABEL("w1", -100, 50), LABEL("w2", 240, 50)]);
    const labels = mount(wires, canvas);
    // Once, at mount.
    expect(reads.count).toBe(1);

    labels.frame({ x: 0, y: 0, zoom: 1 });
    expect(hostNow().style.transform).toBe("translate3d(100px, 40px, 0) scale(1)");
    expect(buttonsNow()).toHaveLength(2);
    expect(buttonsNow()[0]!.style.transform).toBe(BOARD_AT(-100, 50));
    expect(buttonsNow()[1]!.style.transform).toBe(BOARD_AT(240, 50));
    expect(buttonsNow()[0]!.getAttribute("aria-label")).toBe("Select edge - messages");
    const stamped = buttonsNow().map((button) => button.style.transform);

    const writes: Array<MutationRecord> = [];
    const watcher = new MutationObserver((records) => writes.push(...records));
    watcher.observe(hostNow(), { attributes: true, subtree: true, childList: true });

    // A pan: the wrapper follows, the buttons do not move in board space.
    labels.frame({ x: 64, y: -21, zoom: 1 });
    expect(hostNow().style.transform).toBe("translate3d(164px, 19px, 0) scale(1)");
    expect(buttonsNow().map((button) => button.style.transform)).toEqual(stamped);
    expect(writes).toEqual([]);
    const atRest = wires.calls.labelsInView;

    // A resting frame: the loop keeps drawing for a seat ring, and this
    // module neither writes nor forces a layout read.
    labels.frame({ x: 64, y: -21, zoom: 1 });
    labels.frame({ x: 64, y: -21, zoom: 1 });
    expect(hostNow().style.transform).toBe("translate3d(164px, 19px, 0) scale(1)");
    expect(wires.calls.labelsInView).toBe(atRest);
    expect(writes).toEqual([]);
    expect(reads.count).toBe(1);
  });

  it("scales the wrapper and hands each button the inverse, so its target stays 14 px", () => {
    const { canvas } = canvasAt({ left: 100, top: 40 });
    const labels = mount(world([LABEL("w1", -100, 50)]), canvas);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    const host = hostNow();

    labels.frame({ x: 0, y: 0, zoom: 2 });
    expect(host.style.transform).toBe("translate3d(100px, 40px, 0) scale(2)");
    expect(host.style.getPropertyValue("--wire-label-scale")).toBe("0.5");
    // The button stays in board space: the camera is the wrapper's business.
    expect(buttonsNow()[0]!.style.transform).toBe(BOARD_AT(-100, 50));

    labels.frame({ x: 0, y: 0, zoom: 0.25 });
    expect(host.style.transform).toBe("translate3d(100px, 40px, 0) scale(0.25)");
    expect(host.style.getPropertyValue("--wire-label-scale")).toBe("4");
    expect(buttonsNow()[0]!.style.transform).toBe(BOARD_AT(-100, 50));
  });

  it("admits and drops buttons as the view changes, leaving the rest untouched", () => {
    const { canvas } = canvasAt({ left: 100, top: 40 });
    const wires = world([LABEL("w1", -100, 50), LABEL("w2", 240, 50)]);
    const labels = mount(wires, canvas);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    const w2 = buttonsNow()[1]!;
    expect(buttonsNow()).toHaveLength(2);

    // A pan brought w3 into view and carried w1 out: no wire moved.
    wires.seen([LABEL("w2", 240, 50), LABEL("w3", 410, -30)]);
    labels.frame({ x: 12, y: 8, zoom: 1 });

    const now = buttonsNow();
    expect(now).toHaveLength(2);
    expect(now).toContain(w2);
    expect(now.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Select edge - messages",
      "Select edge - messages",
    ]);
    expect(now[1]!.style.transform).toBe(BOARD_AT(410, -30));
    expect(w2.style.transform).toBe(BOARD_AT(240, 50));
  });

  it("re-places buttons when their wires move, not when the camera does", () => {
    const { canvas } = canvasAt({ left: 100, top: 40 });
    const wires = world([LABEL("w1", -100, 50)]);
    const labels = mount(wires, canvas);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    const button = buttonsNow()[0]!;

    wires.moved([LABEL("w1", 30, 12)]);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    expect(buttonsNow()[0]).toBe(button);
    expect(button.style.transform).toBe(BOARD_AT(30, 12));
  });

  it("re-measures the canvas on a layout change, never per frame", () => {
    const box = { left: 100, top: 40 };
    const { canvas, reads } = canvasAt(box);
    const labels = mount(world([LABEL("w1", -100, 50)]), canvas);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    expect(hostNow().style.transform).toBe("translate3d(100px, 40px, 0) scale(1)");

    box.left = 260;
    box.top = 72;
    window.dispatchEvent(new Event("resize"));
    expect(reads.count).toBe(2);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    expect(hostNow().style.transform).toBe("translate3d(260px, 72px, 0) scale(1)");
    expect(reads.count).toBe(2);
  });

  it("takes its buttons away with the canvas", () => {
    const { canvas } = canvasAt({ left: 100, top: 40 });
    const labels = mount(world([LABEL("w1", -100, 50), LABEL("w2", 240, 50)]), canvas);
    labels.frame({ x: 0, y: 0, zoom: 1 });
    expect(buttonsNow()).toHaveLength(2);

    labels.dispose();
    mounted.splice(0, mounted.length);
    expect(document.querySelector('[data-canvas-overlay="wire-labels"]')).toBeNull();
  });
});
