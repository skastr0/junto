// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@shared/settings";
import { templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import { InventoryUnavailableError, type MachineInventory } from "@shared/harness-domain";
import { AgentHarnessPick } from "../src/renderer/components/node-palette/AgentHarnessPick";
import { LaunchSection } from "../src/renderer/components/customize/LaunchSection";
import { AgentCascadeMenu } from "../src/renderer/components/node-palette/AgentCascadeMenu";
import {
  coreHarnessMachineSource,
  pendingHarnessMachineSource,
  setHarnessMachineSource,
} from "../src/renderer/lib/harness-machine-source";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const row = (harness: string, installed: boolean) => ({
  harness,
  machine: "mac-mini",
  installed,
  models: [],
  efforts: [],
  refreshing: false,
});

const miniInventory = {
  machine: "mac-mini",
  harnesses: [row("codex", true), row("claude", false)],
} as unknown as MachineInventory;

const offered = () =>
  [...host.querySelectorAll(".agent-harness-pick__item")].map((item) => item.getAttribute("aria-label"));
const named = (harness: HarnessId) => templateFor(harness).displayName;

const render = async (machine: string) => {
  await act(async () => {
    root.render(<AgentHarnessPick machine={machine} onConfigure={() => {}} />);
  });
};

beforeEach(() => {
  state$.settings.set({ ...defaultSettings(), machine: { ...defaultSettings().machine, name: "macbook" } });
  // This window's own CLIs: Claude only. Another machine must never be offered these.
  (window as { junto?: unknown }).junto = {
    managedTerminalHarnesses: vi.fn(async () => ({ harnesses: [{ harness: "claude", installed: true }] })),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { junto?: unknown }).junto;
  setHarnessMachineSource(coreHarnessMachineSource);
});

describe("the palette picker on another machine", () => {
  it("offers the harnesses that machine has installed, not this window's", async () => {
    setHarnessMachineSource({ ...pendingHarnessMachineSource, inventory: async () => Result.succeed(miniInventory) });
    await render("mac-mini");
    expect(offered()).toEqual([named("codex")]);
  });

  it("offers from the last snapshot when the machine does not answer", async () => {
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async (machine) =>
        Result.fail({
          error: new InventoryUnavailableError({ machine, reason: "unreachable", message: "the link is down" }),
          failure: "LinkUnavailable",
          last: { inventory: miniInventory, receivedAt: Date.now() - 60_000 },
        }),
    });
    await render("mac-mini");
    expect(offered()).toEqual([named("codex")]);
  });

  it("reads this machine through its inventory too, never the local CLI probe", async () => {
    const asked: string[] = [];
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async (machine) => {
        asked.push(machine);
        return Result.succeed({ machine, harnesses: [row("claude", true)] } as unknown as MachineInventory);
      },
    });
    await act(async () => {
      root.render(<AgentHarnessPick onConfigure={() => {}} />);
    });
    expect(asked).toEqual(["macbook"]);
    expect(offered()).toEqual([named("claude")]);
    expect((window as { junto?: { managedTerminalHarnesses: ReturnType<typeof vi.fn> } }).junto!.managedTerminalHarnesses).not.toHaveBeenCalled();
  });

  it("Customize re-seats a seat from the machine it sits on", async () => {
    setHarnessMachineSource({ ...pendingHarnessMachineSource, inventory: async () => Result.succeed(miniInventory) });
    const node = { id: "seat-1", kind: "agent", harness: "codex", host: "mac-mini" };
    await act(async () => {
      root.render(<LaunchSection seat={{ id: "seat-1", name: "mini seat", harness: "codex", node } as never} />);
    });
    expect(offered()).toEqual([`Current ${named("codex")}`]);
  });

  it("Hermes on another machine offers that machine's profiles, not this window's", async () => {
    const profiles = vi.fn(async () => ({ profiles: [{ name: "desk-profile", model: "m" }], source: "cache" }));
    (window as { junto?: Record<string, unknown> }).junto!.managedTerminalProfiles = profiles;
    setHarnessMachineSource({
      ...pendingHarnessMachineSource,
      inventory: async () =>
        Result.succeed({
          machine: "mac-mini",
          harnesses: [{ ...row("hermes", true), profiles: ["mini-coder", "mini-writer"] }],
        } as unknown as MachineInventory),
    });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await act(async () => {
      root.render(
        <AgentCascadeMenu
          harness="hermes"
          machine="mac-mini"
          anchor={anchor}
          onConfigure={() => {}}
          onPointerEnter={() => {}}
          onPointerLeave={() => {}}
        />,
      );
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("mini-coder");
    expect(text).toContain("mini-writer");
    expect(text).not.toContain("desk-profile");
    expect(profiles).not.toHaveBeenCalled();
    anchor.remove();
  });
});
