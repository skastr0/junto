// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "../src/window/components/rts/ConnectionsPanel";
import { deleteEdges } from "../src/window/lib/edge-mutations";
import { flushPendingCanvasSave, undo } from "../src/window/lib/mutations";
import { EMPTY_SETTINGS, state$ } from "../src/window/lib/state";
import { setTasksSource, tasksSource } from "../src/window/lib/tasks-source";
import { TASKS_UNREAD_WARNING } from "../src/window/lib/deletion-impact";
import * as fixtures from "./support/model-nodes";
import { held, openCanvas } from "./support/open-canvas";

vi.hoisted(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  // jsdom has no CSS.escape; list navigation uses it to find the row a move lands on.
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  // List navigation moves the keyboard once the row shows; here it shows at once.
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

let host: HTMLDivElement;
let root: Root;
let oldApi: typeof window.junto;
let confirms: string[];
let closed: number;
let counter = 0;

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const wiresNow = () => [...held().wires.keys()].map(String).sort();
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const one = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, selector).toBeTruthy();
  return element!;
};
const press = async (element: HTMLElement) => {
  await act(async () => { element.click(); await flush(); });
  await flushPendingCanvasSave();
};
/** A press from a control that already has the keyboard, as the operator's would. */
const pressFocused = async (element: HTMLElement) => {
  element.focus();
  await press(element);
};
const key = async (element: HTMLElement, name: string) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    await flush();
  });
};
const button = (text: string) => {
  const found = all("button").find((element) => element.textContent?.trim() === text);
  expect(found, text).toBeTruthy();
  return found!;
};
const search = async (value: string) => {
  const input = one('[data-testid="connections-search"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
};
const checkbox = (wireId: string) => one(`[data-wire-id="${wireId}"] input[type="checkbox"]`) as HTMLInputElement;
const rowRemove = (wireId: string) => one(`[data-wire-id="${wireId}"] button[data-row-remove]`);
const status = () => one('[data-testid="connections-status"]').textContent;

const open = async (wires = [
  fixtures.wire("w-cli", "lead", "cli", "messages"),
  fixtures.wire("w-pty", "pty", "lead", "messages"),
  fixtures.wire("w-design", "lead", "design", "messages"),
]) => {
  openCanvas(`connections-${++counter}`, [
    fixtures.region("cli-region", { x: 1000, y: 0, width: 900, height: 400 }, { label: "CLI" }),
    fixtures.seat("lead", { label: "product-lead", x: 10, y: 2010 }),
    fixtures.seat("design", { label: "product-design", x: 300, y: 2010 }),
    fixtures.seat("cli", { label: "cli-lead", x: 1010, y: 10 }),
    fixtures.seat("pty", { label: "pty-lead", x: 1300, y: 10 }),
  ].map((node, z) => ({ ...node, z })), wires);
  await act(async () => {
    root.render(<ConnectionsPanel nodeId="lead" onClose={() => { closed += 1; }} />);
    await flush();
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = { modelCommand: async () => ({ seq: 1 }) };
  confirms = [];
  closed = 0;
  window.confirm = (message?: string) => { confirms.push(String(message)); return true; };
  state$.settings.set(EMPTY_SETTINGS);
  state$.actorRefs.set([]);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await flush(); });
  host.remove();
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.unstubAllGlobals();
});

it("lists every wire on the seat, grouped by the other end's region, each said as a sentence", async () => {
  await open();
  expect(one('[role="dialog"]').getAttribute("aria-label")).toBe("Connections, product-lead");
  expect(all('[data-testid="connections-row"]').map((row) => row.dataset.wireId)).toEqual(["w-cli", "w-pty", "w-design"]);
  expect(all(".connections-panel__group-name").map((head) => head.textContent)).toEqual(["CLI", "Open field"]);
  expect(one('[data-wire-id="w-pty"]').textContent).toContain("pty-lead messages product-lead");
  expect(one('[data-wire-id="w-cli"] button[data-row-remove]').getAttribute("aria-label")).toBe("Remove: product-lead messages cli-lead");
  // Each group is a named list, not a landmark per region; each row has a name of its own.
  expect(document.querySelectorAll("section")).toHaveLength(0);
  expect(one('[role="list"]').getAttribute("aria-label")).toBe("CLI, 2");
  expect(one('[data-wire-id="w-cli"]').getAttribute("aria-label")).toBe("product-lead messages cli-lead");
  // The count is the number, and " connections" is there for a screen reader.
  expect(one(".connections-panel__count").textContent).toBe("3 connections");
});

it("takes the keyboard on open, at the search, and says nothing at rest", async () => {
  await open();
  expect(document.activeElement).toBe(one('[data-testid="connections-search"]'));
  expect(status()).toBe("");
});

it("removes one row at once, with no question, and undo brings it back", async () => {
  await open();
  await pressFocused(rowRemove("w-cli"));
  expect(confirms).toEqual([]);
  expect(wiresNow()).toEqual(["w-design", "w-pty"]);
  expect(all('[data-testid="connections-row"]').map((row) => row.dataset.wireId)).toEqual(["w-pty", "w-design"]);
  // The keyboard goes to the X of the row that took its place.
  expect(document.activeElement).toBe(rowRemove("w-pty"));
  expect(status()).toContain("Removed: product-lead messages cli-lead");
  expect(status()).toContain("Undo with");
  await act(async () => { undo(); await flush(); });
  await flushPendingCanvasSave();
  expect(wiresNow()).toEqual(["w-cli", "w-design", "w-pty"]);
});

it("keeps the keyboard in the list when the last row goes", async () => {
  await open([fixtures.wire("w-cli", "lead", "cli", "messages")]);
  await pressFocused(rowRemove("w-cli"));
  expect(wiresNow()).toEqual([]);
  // No rows are left, so the keyboard goes to Add, which is what the list offers.
  expect(document.activeElement).toBe(one('[data-testid="connections-add"]'));
});

it("removes several chosen after asking in the foot how many, and Cancel keeps them", async () => {
  await open();
  await pressFocused(checkbox("w-cli"));
  await pressFocused(checkbox("w-design"));
  expect(status()).toBe("2 chosen");
  await pressFocused(one('[data-testid="connections-remove-chosen"]'));
  expect(one('[data-testid="connections-foot"]').textContent).toContain("Remove 2 connections?");
  // The question takes the keyboard at its safe answer.
  expect(document.activeElement).toBe(button("Cancel"));
  await pressFocused(button("Cancel"));
  expect(wiresNow()).toEqual(["w-cli", "w-design", "w-pty"]);
  // Back to the button that asked.
  expect(document.activeElement).toBe(one('[data-testid="connections-remove-chosen"]'));
  await pressFocused(one('[data-testid="connections-remove-chosen"]'));
  await pressFocused(one('[data-testid="connections-remove-confirm"]'));
  expect(confirms).toEqual([]);
  expect(wiresNow()).toEqual(["w-pty"]);
  expect(document.querySelector('[data-testid="connections-foot"]')).toBeNull();
  // The keyboard lands on the row now at the first removed place.
  expect(document.activeElement).toBe(checkbox("w-pty"));
  expect(status()).toContain("Removed 2 connections");
});

it("removes one chosen from the foot without the question, and stays at that place", async () => {
  await open();
  await pressFocused(checkbox("w-pty"));
  await pressFocused(one('[data-testid="connections-remove-chosen"]'));
  expect(wiresNow()).toEqual(["w-cli", "w-design"]);
  expect(confirms).toEqual([]);
  expect(document.activeElement).toBe(checkbox("w-design"));
  expect(status()).toContain("Removed: pty-lead messages product-lead");
});

it("keeps a cancelled task-impact removal's chosen rows", async () => {
  await open([fixtures.wire("w-flow", "lead", "cli", "flows")]);
  const old = tasksSource();
  setTasksSource({ ...old, all: () => Promise.reject(new Error("unread")) });
  try {
    window.confirm = (message?: string) => { confirms.push(String(message)); return false; };
    await pressFocused(checkbox("w-flow"));
    expect(status()).toBe("1 chosen");
    await pressFocused(one('[data-testid="connections-remove-chosen"]'));
    expect(confirms).toEqual([`Delete this relation? ${TASKS_UNREAD_WARNING}`]);
    expect(wiresNow()).toEqual(["w-flow"]);
    expect(checkbox("w-flow").checked).toBe(true);
    expect(one('[data-testid="connections-foot"]').textContent).toContain("1 chosen");
    expect(status()).toBe("1 chosen");
  } finally { setTasksSource(old); }
});

it("searches by name and region path, and says when nothing matches", async () => {
  await open();
  await search("cli");
  expect(all('[data-testid="connections-row"]').map((row) => row.dataset.wireId)).toEqual(["w-cli", "w-pty"]);
  await search("nobody");
  expect(document.body.textContent).toContain("No connection matches");
  await press(button("Clear"));
  expect(all('[data-testid="connections-row"]')).toHaveLength(3);
});

it("says a seat has no connections yet, takes the keyboard at Add, and Escape closes the pop", async () => {
  await open([]);
  expect(document.body.textContent).toContain("No connections yet");
  expect(document.activeElement).toBe(one('[data-testid="connections-add"]'));
  await key(document.activeElement as HTMLElement, "Escape");
  expect(closed).toBe(1);
});

it("opens the connect search from Add, and its close comes back to Add", async () => {
  await open([]);
  await press(one('[data-testid="connections-add"]'));
  expect(document.querySelector(".connect-pick")).toBeTruthy();
  await key(one(".connect-pick input"), "Escape");
  expect(document.querySelector('[data-testid="connections-panel"]')).toBeTruthy();
  expect(closed).toBe(0);
  expect(document.activeElement).toBe(one('[data-testid="connections-add"]'));
});

it("walks the rows from their checkboxes with the arrow keys, and Escape closes", async () => {
  await open();
  const field = one('[data-testid="connections-search"]');
  await key(field, "ArrowDown");
  expect(document.activeElement).toBe(checkbox("w-cli"));
  await key(checkbox("w-cli"), "ArrowDown");
  expect(document.activeElement).toBe(checkbox("w-pty"));
  await key(checkbox("w-pty"), "Escape");
  expect(closed).toBe(1);
});

it("still asks before a removal that touches tasks on their way, even from a quiet caller", async () => {
  await open([fixtures.wire("w-flow", "lead", "cli", "flows")]);
  const old = tasksSource();
  setTasksSource({ ...old, all: () => Promise.reject(new Error("unread")) });
  try {
    window.confirm = (message?: string) => { confirms.push(String(message)); return false; };
    await act(async () => { await deleteEdges(["w-flow"], { quiet: true }); });
    expect(confirms).toEqual([`Delete this relation? ${TASKS_UNREAD_WARNING}`]);
    expect(wiresNow()).toEqual(["w-flow"]);
  } finally { setTasksSource(old); }
});
