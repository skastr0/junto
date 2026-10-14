// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentTerminalHost } from "../src/renderer/components/terminal/PersistentTerminalHost";
import { terminal$, registerTerminalSlot } from "../src/renderer/lib/terminal-state";
import { terminal } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const opened = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer/components/terminal/TerminalSurface", () => ({
  TerminalSurface: () => {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      opened(ref.current?.closest("[data-terminal-slot]") !== null, ref.current?.closest("[hidden]") !== null);
    }, []);
    return <div ref={ref} />;
  },
}));
let dispose = () => {};
afterEach(() => {
  dispose();
  registerTerminalSlot("raw", null);
  terminal$.openByNodeId.set({});
  vi.unstubAllGlobals();
});

it("mounts a raw terminal only after its persistent host reaches a slot, and keeps it on remount", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  opened.mockClear();
  const mount = document.createElement("div");
  const slot = document.createElement("section");
  slot.dataset.terminalSlot = "";
  document.body.append(mount, slot);
  const root = createRoot(mount);
  dispose = () => { act(() => root.unmount()); mount.remove(); slot.remove(); };
  terminal$.openByNodeId.raw.set(terminal("raw"));
  act(() => root.render(<PersistentTerminalHost />));
  expect(opened).not.toHaveBeenCalled();
  act(() => registerTerminalSlot("raw", slot));
  expect(opened).toHaveBeenCalledExactlyOnceWith(true, false);
  act(() => registerTerminalSlot("raw", null));
  act(() => registerTerminalSlot("raw", slot));
  expect(opened).toHaveBeenCalledTimes(1);
});
