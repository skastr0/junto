// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFrontModal,
  focusStopsIn,
  frontModalLayer,
  nextTabStop,
  pushModal,
  resetModalStack,
  topOf,
  type ModalLayer,
} from "../src/renderer/lib/modal-stack";

const entry = (layer: ModalLayer, seq: number) => ({ layer, seq });

describe("modal stack order", () => {
  it("has no top when nothing is open", () => {
    expect(topOf([])).toBeUndefined();
  });

  it("puts an operator modal above everything, whenever it opened", () => {
    const operator = entry("operator", 0);
    expect(topOf([operator, entry("working", 1), entry("working-dialog", 2)])).toBe(operator);
  });

  it("puts a dialog above the working modal it opened from", () => {
    const dialog = entry("working-dialog", 1);
    expect(topOf([entry("working", 0), dialog])).toBe(dialog);
    expect(topOf([dialog, entry("working", 2)])).toBe(dialog);
  });

  it("puts the latest opened on top within a layer", () => {
    const later = entry("working", 5);
    expect(topOf([entry("working", 1), later, entry("working", 3)])).toBe(later);
  });
});

describe("tab trap", () => {
  const stop = (name: string, visible = true) => ({ name, getClientRects: () => ({ length: visible ? 1 : 0 }) });
  const a = stop("a");
  const b = stop("b");
  const c = stop("c");

  it("lets the browser move between stops inside the modal", () => {
    expect(nextTabStop([a, b, c], a, false)).toBeNull();
    expect(nextTabStop([a, b, c], b, true)).toBeNull();
  });

  it("wraps at both ends", () => {
    expect(nextTabStop([a, b, c], c, false)).toBe(a);
    expect(nextTabStop([a, b, c], a, true)).toBe(c);
  });

  it("brings focus in when it sits on the frame or outside", () => {
    expect(nextTabStop([a, b, c], null, false)).toBe(a);
    expect(nextTabStop([a, b, c], stop("elsewhere"), true)).toBe(c);
  });

  it("skips stops that are not on screen", () => {
    const hidden = stop("hidden", false);
    expect(nextTabStop([a, b, hidden], b, false)).toBe(a);
  });

  it("does nothing in a modal with no stops", () => {
    expect(nextTabStop([], null, false)).toBeNull();
  });
});

describe("stops inside an open shadow root", () => {
  const mount = (html: string): HTMLElement => {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    return root;
  };

  it("walks a shadow root at its host's place, not after the whole modal", () => {
    const root = mount(`<button id="first">first</button><div id="host"></div><button id="after">after</button>`);
    const host = root.querySelector<HTMLElement>("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input id="field" /><button id="row">row</button>`;

    expect(focusStopsIn(root).map((stop) => stop.id)).toEqual(["first", "field", "row", "after"]);
    root.remove();
  });

  it("keeps Tab moving through a tree instead of pulling it back to the modal's edges", () => {
    const root = mount(`<button id="first">first</button><div id="host"></div><button id="after">after</button>`);
    const host = root.querySelector<HTMLElement>("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button id="row" tabindex="0">row</button><button id="last-row" tabindex="-1">last</button>`;
    // jsdom lays nothing out; a real window gives every one of these a rect.
    const stops = focusStopsIn(root).map((stop) => Object.assign(stop, { getClientRects: () => ({ length: 1 }) }));

    // A row with the keyboard is a stop the trap can find by identity, so the
    // browser's own move stands and nothing is pulled forward.
    expect(stops.map((stop) => stop.id)).toEqual(["first", "row", "after"]);
    expect(nextTabStop(stops, stops[1], false)).toBeNull();
    // The ends still wrap, and they now wrap around the tree too.
    expect(nextTabStop(stops, stops[2], false)).toBe(stops[0]);
    expect(nextTabStop(stops, stops[0], true)).toBe(stops[2]);
    root.remove();
  });

  it("leaves out stops the operator cannot see", () => {
    const root = mount(`<div id="host"></div>`);
    const shadow = root.querySelector<HTMLElement>("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button id="shown">shown</button><button id="gone" tabindex="-1">gone</button><button id="off" disabled>off</button>`;

    expect(focusStopsIn(root).map((stop) => stop.id)).toEqual(["shown"]);
    root.remove();
  });
});

describe("who is topmost", () => {
  afterEach(() => resetModalStack());
  const open = (layer: ModalLayer, onClose: () => void = () => undefined) =>
    pushModal({ layer, trap: true, container: () => null, onEscape: () => true, onClose });

  it("closes the front modal only, and says when the canvas is in front", () => {
    const closed: string[] = [];
    expect(frontModalLayer()).toBeNull();
    expect(closeFrontModal()).toBe(false);
    const terminal = open("working", () => { closed.push("terminal"); terminal.leave(); });
    const search = open("operator", () => { closed.push("search"); search.leave(); });
    expect(frontModalLayer()).toBe("operator");
    expect(closeFrontModal()).toBe(true);
    expect(closed).toEqual(["search"]);
    expect(frontModalLayer()).toBe("working");
    expect(closeFrontModal()).toBe(true);
    expect(closed).toEqual(["search", "terminal"]);
    expect(frontModalLayer()).toBeNull();
  });


  it("is the dialog while it is open over its working modal, then the modal again", () => {
    const editor = open("working");
    expect(editor.isTop()).toBe(true);
    const dialog = open("working-dialog");
    expect(editor.isTop()).toBe(false);
    expect(dialog.isTop()).toBe(true);
    dialog.leave();
    expect(editor.isTop()).toBe(true);
  });

  it("is a dialog opened from an operator modal, over that modal", () => {
    const feed = open("operator");
    const viewer = open("operator-dialog");
    expect([feed.isTop(), viewer.isTop()]).toEqual([false, true]);
    viewer.leave();
    expect(feed.isTop()).toBe(true);
  });

  it("is the operator modal over both", () => {
    const editor = open("working");
    const dialog = open("working-dialog");
    const search = open("operator");
    expect([editor.isTop(), dialog.isTop(), search.isTop()]).toEqual([false, false, true]);
  });
});
