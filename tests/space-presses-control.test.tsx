// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { spacePressesControl } from "../src/renderer/lib/urgency-step";

afterEach(() => {
  document.body.innerHTML = "";
});

const at = (html: string, id: string, code = "Space") => {
  document.body.innerHTML = html;
  return { code, target: document.getElementById(id) };
};

describe("Space with the keyboard on a control", () => {
  it("presses a focused button or link, on the canvas and in the top bar", () => {
    expect(spacePressesControl(at(`<header><button id="x">Settings</button></header>`, "x"))).toBe(true);
    expect(spacePressesControl(at(`<a id="x" href="#">Docs</a>`, "x"))).toBe(true);
    expect(spacePressesControl(at(`<div class="react-flow__node"><button id="x">Open</button></div>`, "x"))).toBe(true);
    expect(spacePressesControl(at(`<div id="x" role="switch" tabindex="0"></div>`, "x"))).toBe(true);
  });

  it("steps to the next agent when the canvas itself has the keyboard", () => {
    expect(spacePressesControl(at(`<div id="x" class="react-flow__node" role="button" tabindex="0"></div>`, "x"))).toBe(false);
    expect(spacePressesControl(at(`<div id="x" class="react-flow__pane"></div>`, "x"))).toBe(false);
    expect(spacePressesControl({ code: "Space", target: document.body })).toBe(false);
    expect(spacePressesControl({ code: "Space", target: null })).toBe(false);
  });

  it("leaves the backtick alone: it presses nothing", () => {
    expect(spacePressesControl(at(`<button id="x">Settings</button>`, "x", "Backquote"))).toBe(false);
  });
});
