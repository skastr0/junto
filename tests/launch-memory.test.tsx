// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostDirectoryRead = vi.fn(async (_host: string, path: string) => ({
  root: path === "~" ? "/Users/op" : path,
  entries: [],
}));
vi.mock("../src/renderer/lib/junto-api", () => ({ getJuntoApi: () => ({ hostDirectoryRead }) }));

import { AgentLaunchContext, type AgentLaunchContextValue } from "../src/renderer/components/node-palette/AgentLaunchContext";
import { forgetLaunches, isHomeFolder, rememberLaunch } from "../src/renderer/lib/launch-memory";
import { thisMachineName } from "../src/renderer/lib/machines";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let last: AgentLaunchContextValue | undefined;

const mount = async (): Promise<void> => {
  root = createRoot(host);
  await act(async () => {
    root.render(
      <AgentLaunchContext
        position={{ x: 5000, y: 5000 }}
        onChange={(value) => {
          last = value;
        }}
        folderOpen={false}
        onFolderOpenChange={() => undefined}
      />,
    );
  });
};

const unmount = (): void => act(() => root.unmount());
const handed = (): string | undefined => last?.cwd;
const folder = (): string => host.querySelector('[data-testid="launch-folder"]')!.textContent ?? "";

beforeEach(() => {
  forgetLaunches();
  state$.canvasName.set("launch-test");
  last = undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe("isHomeFolder", () => {
  it("is the home folder itself, written either way, and nothing inside it", () => {
    expect(isHomeFolder("~", undefined)).toBe(true);
    expect(isHomeFolder("~/", undefined)).toBe(true);
    expect(isHomeFolder("/Users/op/", "/Users/op")).toBe(true);
    expect(isHomeFolder("/Users/op/code", "/Users/op")).toBe(false);
    expect(isHomeFolder("/Users/op", undefined)).toBe(false);
    expect(isHomeFolder("", "/Users/op")).toBe(false);
  });
});

describe("Add item launch context", () => {
  it("reopens on the folder chosen last on this canvas", async () => {
    rememberLaunch("launch-test", thisMachineName(), "/Users/op/code/junto");
    await mount();
    expect(folder()).toBe("/Users/op/code/junto");
    expect(handed()).toBe("/Users/op/code/junto");
    unmount();
    last = undefined;
    await mount();
    expect(handed()).toBe("/Users/op/code/junto");
    unmount();
  });

  it("with nothing chosen it asks for a folder and hands on none", async () => {
    await mount();
    expect(folder()).toBe("choose folder");
    expect(handed()).toBe("");
    unmount();
  });

  it("never hands on the home folder, and says why", async () => {
    rememberLaunch("launch-test", thisMachineName(), "/Users/op");
    await mount();
    expect(handed()).toBe("");
    expect(folder()).toBe("choose folder");
    expect(host.querySelector('[data-testid="launch-folder-home"]')).not.toBeNull();
    unmount();
  });
});
