// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimFocus,
  claimFocusOnMount,
  isOperatorTyping,
  noteOperatorGesture,
  releaseFocus,
  resetOperatorGesture,
} from "../src/renderer/lib/focus-ownership";

const mount = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
};

const q = <T extends HTMLElement>(root: HTMLElement, selector: string): T =>
  root.querySelector<T>(selector)!;

// jsdom has no layout; async claims need a box.
const giveBox = (el: HTMLElement): void => {
  el.getClientRects = () => ({ length: 1 }) as DOMRectList;
};

describe("focus law authority", () => {
  let root: HTMLElement;

  beforeEach(() => {
    resetOperatorGesture();
    root = mount(`
      <div class="react-flow__node" data-id="agent">
        <input id="rename" data-focus-owner="canvas-draft" />
      </div>
      <div role="dialog" id="modal">
        <input id="modal-field" />
        <button id="modal-button">ok</button>
      </div>
      <div class="xterm" id="term"><textarea class="xterm-helper-textarea" id="term-input"></textarea></div>
      <button id="chrome">chrome</button>
    `);
  });

  afterEach(() => {
    root.remove();
  });

  const typeIn = (id: string): HTMLInputElement => {
    const field = q<HTMLInputElement>(root, `#${id}`);
    field.focus();
    noteOperatorGesture({ target: field, kind: "key", chord: false });
    return field;
  };

  it("refuses async claims while the operator types (class C)", () => {
    const rename = typeIn("rename");
    const term = q<HTMLTextAreaElement>(root, "#term-input");
    giveBox(term);

    expect(claimFocus(term, "async")).toBe(false);
    expect(document.activeElement).toBe(rename);
  });

  it("refuses a mount-time claim licensed only by typing", () => {
    const rename = typeIn("rename");

    claimFocusOnMount(q(root, "#modal-field"));

    expect(document.activeElement).toBe(rename);
  });

  it("lets a pointer press outside the field license an open", () => {
    typeIn("rename");
    noteOperatorGesture({ target: q(root, "#chrome"), kind: "pointer", chord: false });

    expect(claimFocus(q(root, "#modal-field"), "open")).toBe(true);
  });

  it("does not let a pointer press inside the field license an open", () => {
    const rename = typeIn("rename");
    noteOperatorGesture({ target: rename, kind: "pointer", chord: false });

    expect(claimFocus(q(root, "#modal-field"), "open")).toBe(false);
  });

  it("lets a command chord license an open from inside a field", () => {
    const term = typeIn("term-input");
    noteOperatorGesture({ target: term, kind: "key", chord: true });

    expect(claimFocus(q(root, "#modal-field"), "open")).toBe(true);
  });

  it("lets a surface move focus within its own scope while typing", () => {
    typeIn("modal-field");

    expect(claimFocus(q(root, "#modal-button"), "gesture", {
      event: { target: q(root, "#modal-field"), type: "keydown" },
    })).toBe(true);
  });

  it("refuses a gesture handler that exports focus out of a typing field", () => {
    const rename = typeIn("rename");

    expect(claimFocus(q(root, "#modal-field"), "gesture", {
      event: { target: rename, type: "keydown" },
    })).toBe(false);
    expect(document.activeElement).toBe(rename);
  });

  it("claims freely when nothing owns focus", () => {
    const field = q<HTMLInputElement>(root, "#modal-field");
    field.value = "abc";

    expect(claimFocus(field, "open", { select: true })).toBe(true);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(3);
  });

  it("never lets async work take focus from another control", () => {
    q<HTMLButtonElement>(root, "#chrome").focus();
    const term = q<HTMLTextAreaElement>(root, "#term-input");
    giveBox(term);

    expect(claimFocus(term, "async")).toBe(false);
  });

  it("refuses async claims on parked surfaces", () => {
    expect(claimFocus(q(root, "#term-input"), "async")).toBe(false);
  });

  it("releases only the element that holds focus", () => {
    const rename = typeIn("rename");
    const other = q<HTMLInputElement>(root, "#modal-field");

    expect(releaseFocus(other, "gesture")).toBe(false);
    expect(document.activeElement).toBe(rename);
    expect(releaseFocus(rename, "gesture")).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("isOperatorTyping", () => {
  it("covers every field the operator types into", () => {
    const root = mount(`
      <input id="text" />
      <input id="check" type="checkbox" />
      <textarea id="area"></textarea>
      <div id="rich" contenteditable="true"><span id="rich-inner">x</span></div>
      <div id="plain" contenteditable="false"></div>
      <div class="xterm"><div id="xterm-chrome"></div></div>
      <button id="button">b</button>
    `);
    const typing = (id: string) => isOperatorTyping(root.querySelector(`#${id}`));

    expect(typing("text")).toBe(true);
    expect(typing("area")).toBe(true);
    expect(typing("rich-inner")).toBe(true);
    expect(typing("xterm-chrome")).toBe(true);
    expect(typing("check")).toBe(false);
    expect(typing("plain")).toBe(false);
    expect(typing("button")).toBe(false);
    expect(isOperatorTyping(null)).toBe(false);
    root.remove();
  });
});
