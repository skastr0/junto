// @vitest-environment jsdom
/**
 * The multi-select menu the GPU canvas draws (track F): it lists the rows a
 * selection has, and its delete asks the same question and writes the same
 * one Remove the DOM menu writes. No React Flow is mounted.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName, type Command } from "../src/shared/model";
import { CanvasMenus } from "../src/window/canvas/shell/CanvasMenus";
import { canvasMenu$, closeCanvasMenu, openCanvasMenu } from "../src/window/canvas/shell/canvas-menu";
import { authoring } from "../src/window/lib/authoring";
import { modelStore } from "../src/window/lib/use-model";
import { state$ } from "../src/window/lib/state";
import { note } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sent: Command[] = [];
let release: (() => void) | undefined;
let root: Root | undefined;

const open = (): void => {
  state$.canvasName.set("menus");
  authoring.forget("menus");
  release = modelStore.adopt({
    canvas: asCanvasName("menus"),
    seq: 0,
    nodes: [note("a", "a"), note("b", "b", { x: 300 })],
    wires: [],
  });
};

beforeEach(() => {
  sent = [];
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window, {
    confirm: () => true,
    junto: {
      modelCommand: async (command: Command) => {
        sent.push(command);
        return { seq: sent.length };
      },
    },
  });
  open();
  state$.selectedNodeIds.set(["a", "b"]);
  state$.selectedNodeId.set("a");
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    root = undefined;
  });
  closeCanvasMenu();
  await authoring.idle();
  release?.();
  release = undefined;
  authoring.forget("menus");
});

const render = async (): Promise<HTMLElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<CanvasMenus />);
  });
  return host;
};

const click = async (host: HTMLElement, label: string): Promise<void> => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label);
  if (button === undefined) throw new Error(`no button labelled ${label}`);
  await act(async () => {
    button.click();
  });
};

describe("the multi-select menu", () => {
  it("lists the selection's rows", async () => {
    openCanvasMenu({ kind: "menu", target: "selection", at: { x: 100, y: 100 }, screen: { x: 100, y: 100 } });
    const host = await render();
    expect(host.textContent).toContain("create region");
    expect(host.textContent).toContain("delete 2 nodes");
  });

  it("deletes the selection in one Remove after the confirm", async () => {
    openCanvasMenu({ kind: "menu", target: "selection", at: { x: 100, y: 100 }, screen: { x: 100, y: 100 } });
    const host = await render();
    await click(host, "Delete 2 nodes");
    await act(async () => {
      await authoring.idle();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    const removes = sent.filter((command) => command._tag === "Remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatchObject({ nodes: ["a", "b"] });
    expect(modelStore.node$("menus", "a").peek()).toBeUndefined();
  });
});
