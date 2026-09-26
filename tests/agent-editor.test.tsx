// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { managedAgentEther } from "./helpers/managed-agent-ether";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/renderer/lib/theme-mode", async () => {
  const { observable } = await import("@legendapp/state");
  return { themeMode$: observable<"dark" | "bright">("dark") };
});

const renames: Array<readonly [string, string]> = [];
vi.mock("../src/renderer/lib/mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/lib/mutations")>()),
  renameTerminalNode: (id: string, name: string) => renames.push([id, name]),
}));

const { AgentEditorHost, CustomizeAgentButton } = await import("../src/renderer/components/agent-editor/AgentEditor");
const { AGENT_EDITOR_SECTIONS } = await import("../src/renderer/components/agent-editor/sections");
const { agentEditor$, closeAgentEditor, openAgentEditor } = await import("../src/renderer/lib/agent-editor-state");
const { state$ } = await import("../src/renderer/lib/state");
const { portraitOverrides$ } = await import("../src/renderer/lib/portrait-overrides-state");
const { normalizePortraitOverride } = await import("../src/shared/portrait-overrides");
const { installCosmeticPacks } = await import("../src/shared/cosmetics/catalog");
const { decodeCosmeticPacks } = await import("../src/shared/cosmetics/load");

const seat: CanvasNode = {
  id: "seat-1",
  type: "text",
  text: "planner",
  x: 0,
  y: 0,
  width: 240,
  height: 96,
  ether: managedAgentEther("local:planner"),
} as CanvasNode;

let host: HTMLDivElement;
let root: Root;
const patches: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  patches.length = 0;
  renames.length = 0;
  portraitOverrides$.set({});
  state$.doc.set({ ...state$.doc.peek(), nodes: [seat] });
  // The main-process store: normalizes and echoes the stored override.
  (window as unknown as { junto: unknown }).junto = {
    portraitOverrideSet: async (seatId: string, override: unknown) => {
      patches.push({ seatId, override });
      return { ok: true, seatId, override: override === null ? null : normalizePortraitOverride(override) };
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <CustomizeAgentButton identity="seat-1" name="planner" hint>
          <span>ring</span>
        </CustomizeAgentButton>
        <AgentEditorHost />
      </>,
    ),
  );
});

afterEach(() => {
  act(() => closeAgentEditor());
  act(() => root.unmount());
  host.remove();
  state$.doc.set({ ...state$.doc.peek(), nodes: [] });
  vi.useRealTimers();
});

const editor = (): HTMLElement => {
  const found = document.querySelector('[data-testid="agent-editor"]');
  if (!(found instanceof HTMLElement)) throw new Error("editor is not open");
  return found;
};

const open = (section?: string): HTMLElement => {
  if (section) act(() => openAgentEditor("seat-1", { section }));
  else act(() => (host.querySelector('[data-testid="customize-agent-button"]') as HTMLButtonElement).click());
  return editor();
};

const tab = (label: string): void =>
  act(() => ([...editor().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((each) => each.textContent === label))!.click());

const button = (text: string): HTMLButtonElement =>
  [...editor().querySelectorAll("button")].find((candidate) => candidate.textContent === text) as HTMLButtonElement;

const settle = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
};

const type = (input: HTMLInputElement, value: string): void =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

// Every option is a live thumbnail; under a loaded machine a full editor
// render takes a few seconds in jsdom.
describe("customize agent editor", { timeout: 30_000 }, () => {
  it("opens from the portrait on Look, with Mood and Name beside it", () => {
    const button = host.querySelector('[data-testid="customize-agent-button"]')!;
    expect(button.getAttribute("aria-label")).toBe("Customize planner");
    expect(button.querySelector(".customize-agent-button__tag")?.textContent).toBe("Customize");
    const opened = open();
    expect(opened.getAttribute("aria-label")).toBe("Customize planner");
    expect([...opened.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["look", "mood", "name"]);
    expect(opened.querySelector('[role="tabpanel"]')?.getAttribute("data-section")).toBe("look");
    for (const label of ["color", "body", "ears and toppers", "hats and props", "eyes", "brows", "mouth", "pattern", "accent"]) {
      expect(opened.querySelector(`[role="radiogroup"][aria-label="${label}"]`)).not.toBeNull();
    }
    expect(opened.querySelectorAll('[role="radio"][aria-checked="true"]').length).toBe(9);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("saves a picked look for the seat and resets it", async () => {
    const opened = open();
    act(() => (opened.querySelector('[aria-label="body Toast"]') as HTMLButtonElement).click());
    await settle();
    expect(portraitOverrides$.peek()["seat-1"]).toEqual({ shape: "toast" });
    expect(opened.querySelector('[aria-label="body Toast"]')?.getAttribute("aria-checked")).toBe("true");

    act(() => button("Reset").click());
    await settle();
    expect(patches.at(-1)).toEqual({ seatId: "seat-1", override: null });
    expect(portraitOverrides$.peek()["seat-1"]).toBeUndefined();
  });

  it("sets temperament on Mood, which Randomize on Look keeps", async () => {
    open();
    tab("mood");
    expect(editor().querySelectorAll(".agent-editor__moods figure")).toHaveLength(6);
    type(editor().querySelector('input[type="range"]') as HTMLInputElement, "-0.8");
    await settle();
    expect(portraitOverrides$.peek()["seat-1"]?.temperament).toBe(-0.8);
    expect(editor().textContent).toContain("moody");

    tab("look");
    act(() => button("Randomize").click());
    await settle();
    const saved = portraitOverrides$.peek()["seat-1"];
    expect(saved?.shape).toBeDefined();
    expect(saved?.temperament).toBe(-0.8);
  });

  it("renames the seat from Name on Enter, and drops the typing on Escape", () => {
    const opened = open("name");
    expect(opened.querySelector('[role="tabpanel"]')?.getAttribute("data-section")).toBe("name");
    const input = opened.querySelector('[data-testid="agent-editor-name"]') as HTMLInputElement;
    expect(input.value).toBe("planner");
    type(input, "  lead planner ");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(renames).toEqual([["seat-1", "lead planner"]]);

    type(input, "scrapped");
    act(() => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(agentEditor$.peek()).toBeNull();
    expect(renames).toHaveLength(1);
  });

  it("keeps a typed name when the editor closes around it, never an empty one", () => {
    const input = open("name").querySelector('[data-testid="agent-editor-name"]') as HTMLInputElement;
    type(input, "   ");
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input.value).toBe("planner");
    expect(renames).toEqual([]);
    type(input, "scout");
    act(() => closeAgentEditor());
    expect(renames).toEqual([["seat-1", "scout"]]);
  });

  it("closes when the seat leaves the canvas", () => {
    open();
    act(() => state$.doc.set({ ...state$.doc.peek(), nodes: [] }));
    expect(document.querySelector('[data-testid="agent-editor"]')).toBeNull();
  });

  it("lists sections in a stable order with unique ids", () => {
    const ids = AGENT_EDITOR_SECTIONS.map((section) => section.id);
    expect(ids.slice(0, 3)).toEqual(["look", "mood", "name"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("groups bundled pack items under their pack and saves the pack key", async () => {
    installCosmeticPacks(
      decodeCosmeticPacks([
        {
          format: 1,
          id: "test-pack",
          name: "Test pack",
          tier: "premium",
          accessories: [
            {
              id: "top-hat",
              name: "Top hat",
              hat: true,
              parts: [{ layer: "hat", anchor: { x: "center", y: "top" }, shapes: [{ kind: "circle", cx: 0, cy: -6, r: 6, paint: "inked", color: "ink" }] }],
            },
          ],
        },
      ]),
    );
    try {
      const props = open().querySelector('[role="radiogroup"][aria-label="hats and props"]');
      expect(props?.querySelector('[data-pack="premium"] .agent-editor__pack-head')?.textContent).toContain("Test pack");
      act(() => (props?.querySelector('[aria-label="hats and props Top hat"]') as HTMLButtonElement).click());
      await settle();
      expect(portraitOverrides$.peek()["seat-1"]).toEqual({ accessory: "test-pack:top-hat" });
    } finally {
      installCosmeticPacks([]);
    }
  });
});
