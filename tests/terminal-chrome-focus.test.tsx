// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  firstChromeControl,
  focusFrontTerminal,
  focusTerminalChrome,
} from "../src/renderer/lib/terminal-chrome-focus";

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
    </div>
    <aside><button id="rail">Rail</button></aside>
  </div>`;

const chord = (key: string): KeyboardEvent => new KeyboardEvent("keydown", { key, metaKey: true });

afterEach(() => {
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

  it("hands the keyboard back to the terminal", () => {
    mount(PANE);
    document.getElementById("details")!.focus();
    expect(focusFrontTerminal(chord("ArrowDown"))).toBe(true);
    expect(document.activeElement?.id).toBe("pty");
  });

  it("does nothing with no terminal in front, so the key passes", () => {
    mount(`<div class="workbench-pane"><div class="note"><header><button>x</button></header></div></div>`);
    expect(focusTerminalChrome(chord("ArrowUp"))).toBe(false);
    expect(focusFrontTerminal(chord("ArrowDown"))).toBe(false);
  });
});
