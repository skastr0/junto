// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type Settings, type SettingsPatch } from "@shared/settings";
import { KEY_TABLE } from "@shared/key-table";
import {
  KeyboardSettingsSection,
  shortcutMatches,
} from "../src/renderer/components/settings/KeyboardSettingsSection";
import { KEY_ACTIONS } from "../src/renderer/lib/key-actions";
import { installKeyDispatcher } from "../src/renderer/lib/key-dispatcher";
import { isOperatorModalOpen, closeOperatorModal } from "../src/renderer/lib/operator-modal";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: SettingsPatch[];
let menuYield: string[];
let uninstall: () => void;

const withKeyboard = (overrides: Record<string, string[]>): Settings => ({
  ...defaultSettings(),
  keyboard: { overrides },
});

beforeEach(() => {
  patches = [];
  menuYield = [];
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  (window as unknown as { junto: unknown }).junto = {
    yieldMenuKeys: (yielding: string) => menuYield.push(yielding),
    settingsPatch: async (patch: SettingsPatch) => {
      patches.push(patch);
      return { ok: true, settings: withKeyboard({ ...(patch.keyboard?.overrides as Record<string, string[]>) }) };
    },
  };
  state$.settings.set(defaultSettings());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  uninstall = installKeyDispatcher(KEY_ACTIONS);
  act(() => root.render(<KeyboardSettingsSection />));
});

afterEach(() => {
  act(() => root.unmount());
  uninstall();
  host.remove();
  closeOperatorModal();
  delete (window as unknown as { junto?: unknown }).junto;
});

const recorder = (name: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Change the keys for ${name}"]`)!;

const startRecording = (name: string): HTMLButtonElement => {
  const button = recorder(name);
  act(() => button.click());
  return host.querySelector<HTMLButtonElement>(`button[aria-label="Press keys for ${name}"]`)!;
};

const press = async (target: Element, init: KeyboardEventInit): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};

describe("keyboard shortcuts section", () => {
  it("lists every shortcut once, under the place its chord works", () => {
    for (const def of KEY_TABLE) {
      const rows = [...host.querySelectorAll('[role="group"]')].filter(
        (row) => row.querySelector(".settings-field__label-row")?.textContent === def.name,
      );
      expect(rows, def.name).toHaveLength(1);
    }
    expect([...host.querySelectorAll("section > h3")].map((title) => title.textContent)).toEqual([
      "Anywhere",
      "Search and feed",
      "Canvas",
      "Agent and terminal",
      "Inside search",
      "Inside the needs-you feed",
      "Inside a preview",
      "Inside the drawing pad",
      "Writing a message",
    ]);
    expect(host.textContent).not.toContain(String.fromCharCode(0xb7));
  });

  it("narrows the list by action name or by key", () => {
    const feed = KEY_TABLE.find((def) => def.id === "feed.open")!;
    expect(shortcutMatches(feed, ["Cmd+I"], true, "needs-you")).toBe(true);
    expect(shortcutMatches(feed, ["Cmd+I"], true, "⌘ i")).toBe(true);
    expect(shortcutMatches(feed, ["Cmd+I"], true, "command i")).toBe(true);
    expect(shortcutMatches(feed, ["Cmd+I"], true, "zoom")).toBe(false);
  });

  it("records a new chord and stores only that change", async () => {
    const button = startRecording("Open the needs-you feed");
    expect(button.textContent).toBe("Press keys");
    const event = await press(button, { key: "j", code: "KeyJ", metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(patches).toEqual([{ keyboard: { overrides: { "feed.open": ["Cmd+J"] } } }]);
    expect(host.querySelector('button[aria-label="Reset Open the needs-you feed to its default keys"]')).not.toBeNull();
  });

  it("keeps a chord pressed while recording from every other shortcut", async () => {
    const button = startRecording("Open the git review");
    // Cmd+K opens search everywhere else; here it is only a chord being recorded.
    await press(button, { key: "k", code: "KeyK", metaKey: true });
    expect(isOperatorModalOpen()).toBe(false);
    expect(patches).toEqual([]);
    expect(host.textContent).toContain("Already used by Open search");
  });

  it("shows who has the chord before saving, and replaces only when asked", async () => {
    const button = startRecording("Open the needs-you feed");
    await press(button, { key: "k", code: "KeyK", metaKey: true });
    expect(patches).toEqual([]);
    const replace = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === "Replace")!;
    await act(async () => replace.click());
    expect(patches).toEqual([{ keyboard: { overrides: { "feed.open": ["Cmd+K"], "search.open": [] } } }]);
  });

  it("refuses a chord the system or the terminal owns, and says why", async () => {
    let button = startRecording("Open the needs-you feed");
    await press(button, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(host.textContent).toContain("Control belongs to the terminal");
    button = startRecording("Open the needs-you feed");
    await press(button, { key: "q", code: "KeyQ", metaKey: true });
    expect(host.textContent).toContain("macOS quits the app");
    expect(patches).toEqual([]);
  });

  it("stands the menu bar down while recording, so Cmd+Q is recorded and refused, not run", async () => {
    const button = startRecording("Open the needs-you feed");
    expect(menuYield).toEqual(["all"]);
    await press(button, { key: "q", code: "KeyQ", metaKey: true });
    expect(menuYield).toEqual(["all", "none"]);
    expect(host.textContent).toContain("macOS quits the app");
  });

  it("cancels on Escape without closing anything, and clears to none on Backspace", async () => {
    let button = startRecording("Open the needs-you feed");
    const escape = await press(button, { key: "Escape", code: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(recorder("Open the needs-you feed")).not.toBeNull();
    expect(patches).toEqual([]);
    button = startRecording("Open the needs-you feed");
    await press(button, { key: "Backspace", code: "Backspace" });
    expect(patches).toEqual([{ keyboard: { overrides: { "feed.open": [] } } }]);
    expect(recorder("Open the needs-you feed").textContent).toBe("none");
  });

  it("says what Backspace and Escape do while recording, and ties a conflict to its button", async () => {
    const button = startRecording("Open the needs-you feed");
    expect(host.textContent).toContain("Backspace for none, Escape to cancel");
    await press(button, { key: "k", code: "KeyK", metaKey: true });
    const again = recorder("Open the needs-you feed");
    const line = document.getElementById(again.getAttribute("aria-describedby")!);
    expect(line?.textContent).toContain("Already used by Open search");
  });

  it("empties the filter on Escape before Escape can reach Settings", async () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter shortcuts"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "zoom");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).not.toContain("Open search");
    const first = await press(input, { key: "Escape", code: "Escape" });
    expect(first.defaultPrevented).toBe(true);
    expect(host.textContent).toContain("Open search");
    const second = await press(input, { key: "Escape", code: "Escape" });
    expect(second.defaultPrevented).toBe(false);
  });

  it("shows a chord that cannot change as keys alone, with the reason", () => {
    expect(host.querySelector('button[aria-label="Change the keys for Switcher: next agent"]')).toBeNull();
    expect(host.textContent).toContain("Cmd is held while the switcher is up");
  });

  it("shows the keys a screen handles itself, and offers no way to change them", () => {
    for (const name of ["Pan the canvas", "Next item", "Pick a tool", "Send"]) {
      expect(host.textContent).toContain(name);
      expect(host.querySelector(`button[aria-label="Change the keys for ${name}"]`)).toBeNull();
    }
    expect(host.textContent).toContain("Built into this screen");
  });

  it("names the screen's own key that a new chord would land on", async () => {
    const button = startRecording("Next agent on the canvas");
    await press(button, { key: "w", code: "KeyW" });
    expect(host.textContent).toContain("Already used by Pan the canvas");
    expect(patches).toEqual([]);
  });

  it("puts a changed shortcut back on its default", async () => {
    await act(async () => state$.settings.set(withKeyboard({ "feed.open": ["Cmd+J"] })));
    const reset = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset Open the needs-you feed to its default keys"]',
    )!;
    await act(async () => reset.click());
    expect(patches).toEqual([{ keyboard: { overrides: {} } }]);
  });
});
