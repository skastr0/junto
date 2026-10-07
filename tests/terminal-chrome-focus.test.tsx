// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  firstChromeControl,
  focusFrontTerminal,
  focusTerminalChrome,
} from "../src/renderer/lib/terminal-chrome-focus";
import { keySituation } from "../src/renderer/lib/key-dispatcher";
import { resolveKey } from "../src/shared/key-table";

const mount = (html: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
};

const PANE = `
  <div class="workbench-pane workbench-pane--parked">
    <div class="native-terminal-surface"><header><button id="parked">Parked</button></header></div>
  </div>
  <div class="workbench-pane">
    <div class="native-terminal-surface">
      <header><button id="portrait">Portrait</button><button id="details">Details</button><button id="off" disabled>Off</button></header>
      <div class="xterm"><textarea id="pty"></textarea></div>
      <aside><button id="rail">Rail</button></aside>
    </div>
  </div>`;

const chord = (key: string): KeyboardEvent => new KeyboardEvent("keydown", { key, metaKey: true });

/** The same chord as it arrives from the element that has the keyboard. */
const chordFrom = (key: string, target: Element): KeyboardEvent => {
  const event = chord(key);
  Object.defineProperty(event, "target", { value: target });
  return event;
};

// jsdom lays nothing out: every element is on screen unless a test says not.
const rects = Element.prototype.getClientRects;
beforeEach(() => {
  Element.prototype.getClientRects = function (this: Element) {
    return (this.hasAttribute("data-offscreen") ? [] : [{}]) as unknown as DOMRectList;
  };
});

afterEach(() => {
  Element.prototype.getClientRects = rects;
  document.body.innerHTML = "";
});

describe("the keyboard's way out of a terminal", () => {
  it("lands on the first control of the header of the terminal in front", () => {
    mount(PANE);
    const pty = document.getElementById("pty")!;
    pty.focus();
    expect(focusTerminalChrome(chord("ArrowUp"))).toBe(true);
    expect(document.activeElement?.id).toBe("portrait");
  });

  it("finds the control by place, skipping a disabled one", () => {
    const host = mount(`<div class="p"><div class="native-terminal-surface"><header><button disabled>a</button><button id="b">b</button></header></div></div>`);
    expect(firstChromeControl(host.querySelector(".p"))?.id).toBe("b");
    expect(firstChromeControl(null)).toBeNull();
  });

  it("never lands on a control that is not on screen", () => {
    const host = mount(`<div class="p"><div class="native-terminal-surface"><header><button data-offscreen>a</button><button id="b">b</button></header></div></div>`);
    expect(firstChromeControl(host.querySelector(".p"))?.id).toBe("b");
  });

  it("stays in the pane the key was pressed in when several terminals are side by side", () => {
    mount(`
      <div class="workbench-pane"><div class="native-terminal-surface">
        <header><button id="one">One</button></header><div class="xterm"><textarea id="pty-one"></textarea></div>
      </div></div>
      <div class="workbench-pane"><div class="native-terminal-surface">
        <header><button id="two">Two</button></header><div class="xterm"><textarea id="pty-two"></textarea></div>
      </div></div>`);
    const pty = document.getElementById("pty-two")!;
    pty.focus();
    expect(focusTerminalChrome(chordFrom("ArrowUp", pty))).toBe(true);
    expect(document.activeElement?.id).toBe("two");
    expect(focusFrontTerminal(chordFrom("ArrowDown", document.activeElement!))).toBe(true);
    expect(document.activeElement?.id).toBe("pty-two");
  });

  it("hands the keyboard back to the terminal", () => {
    mount(PANE);
    document.getElementById("details")!.focus();
    expect(focusFrontTerminal(chord("ArrowDown"))).toBe(true);
    expect(document.activeElement?.id).toBe("pty");
  });

  it("resolves Cmd+Down from the header and the connections, where the way back is needed", () => {
    mount(PANE);
    const down = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "ArrowDown", code: "ArrowDown" };
    for (const id of ["details", "rail"]) {
      const situation = { ...keySituation(document.getElementById(id)), mac: true };
      expect(resolveKey(down, situation)).toEqual({ id: "focus.toTerminal" });
    }
  });

  it("passes Cmd+Down to the program when the keyboard is already in the terminal", () => {
    mount(PANE);
    document.getElementById("pty")!.focus();
    expect(focusFrontTerminal(chord("ArrowDown"))).toBe(false);
    expect(document.activeElement?.id).toBe("pty");
  });

  it("does nothing with no terminal in front, so the key passes", () => {
    mount(`<div class="workbench-pane"><div class="note"><header><button>x</button></header></div></div>`);
    expect(focusTerminalChrome(chord("ArrowUp"))).toBe(false);
    expect(focusFrontTerminal(chord("ArrowDown"))).toBe(false);
  });
});
