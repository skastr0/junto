// @vitest-environment jsdom
/**
 * TopBar MachinesButton and popover: static severity badge, always-open
 * popover, one-click fixes, two-press arming on destructive actions, Update all,
 * running-seats confirmation, and live background updates via onMachinesChanged.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { ConfirmHost } from "../src/window/components/ConfirmHost";
import { MachinesButton } from "../src/window/components/machines/MachinesButton";
import { machines$ } from "../src/window/lib/machines-actions";
import { state$ } from "../src/window/lib/state";
import { KILL_ARM_MS } from "../src/window/lib/terminal-kill-ux";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

vi.hoisted(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const BUILD = "b".repeat(64);
type Request = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> };
type Listed = {
  machine: Record<string, unknown>;
  setUp: boolean;
  needsUpdate: boolean;
  installationId?: string;
  setupState?: "not-installed" | "installed-not-linked" | "set-up";
  updateDirection?: "peer-older" | "this-older" | "different";
};

const row = (id: string, more: Partial<Listed> = {}, machine: Record<string, unknown> = {}): Listed => ({
  machine: { id, label: id, isThisMachine: false, capabilities: ["terminal"], sshEndpoint: `op@${id}`, ...machine },
  setUp: true,
  needsUpdate: false,
  installationId: `inst-${id}`,
  ...more,
});

const makeOwner = (initialRows: Listed[], initialBoat?: { connected: boolean; machines: Array<Record<string, unknown>> }) => {
  const rows: Listed[] = [...initialRows];
  const requests: Request[] = [];
  let progressListener: ((payload: unknown) => void) | undefined;
  let changedListener: (() => void) | undefined;
  const pendingUpdates = new Map<string, (answer: unknown) => void>();
  let boat = initialBoat;

  const ok = (request: Request, data: unknown) =>
    ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
  const refuse = (request: Request, type: string, message: string, details: Record<string, unknown> = {}) =>
    ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false, error: { type, message, details } });

  const listedRows = () =>
    rows.map(({ machine, installationId, setupState, updateDirection, ...rest }) => ({
      machine: Object.fromEntries(Object.entries(machine).filter(([, value]) => value !== undefined)),
      ...rest,
      ...(installationId === undefined ? {} : { installationId }),
      ...(setupState === undefined ? {} : { setupState }),
      ...(updateDirection === undefined ? {} : { updateDirection }),
    }));

  const machineCommand = vi.fn(async (request: Request): Promise<unknown> => {
    requests.push(request);
    const name = request.args.name as string | undefined;
    switch (request.op) {
      case "machine.list":
        return ok(request, { machines: listedRows() });
      case "machine.status":
        if (name === undefined) {
          return ok(request, {
            build: BUILD,
            form: "macbook",
            keychain: "available",
            installationId: `inst-${THIS_MACHINE}`,
            machineName: THIS_MACHINE,
            juntoHome: "/Users/op/.junto",
            pid: 41,
            ready: true,
          });
        }
        return ok(request, {
          machineName: name,
          reachable: true,
          form: "mac-mini",
          installationId: `inst-${name}`,
          harnesses: [{ harness: "claude", installed: true, signIn: "sign-in-unverified" }],
          missingSecrets: [],
        });
      case "machine.harnesses":
        return ok(request, {
          machineName: THIS_MACHINE,
          reachable: true,
          harnesses: [{ harness: "claude", installed: true, signIn: "sign-in-unverified" }],
        });
      case "machine.boat-status":
        if (!boat) return refuse(request, "validation", "unsupported");
        return ok(request, { connected: boat.connected, keyId: "0123abcd", unrevokedKeyIds: [], machines: boat.machines });
      case "machine.update":
      case "machine.send":
        return new Promise((resolve) => pendingUpdates.set(name!, resolve));
      case "machine.boat-delete": {
        const idx = rows.findIndex((r) => r.machine.id === name);
        if (idx >= 0) rows.splice(idx, 1);
        if (boat) boat.machines = boat.machines.filter((m) => m.machineName !== name);
        return ok(request, { machineName: name, removed: true });
      }
      case "machine.remove": {
        const idx = rows.findIndex((r) => r.machine.id === name);
        if (idx >= 0) rows.splice(idx, 1);
        return ok(request, { machineName: name, removed: true });
      }
      default:
        return refuse(request, "validation", "unsupported");
    }
  });

  const lastCopy = (name: string) =>
    requests.filter((r) => r.args.name === name && (r.op === "machine.update" || r.op === "machine.send")).at(-1)!;

  return {
    rows,
    requests,
    api: {
      machineCommand,
      onMachineProgress: (cb: (payload: unknown) => void) => {
        progressListener = cb;
        return () => { progressListener = undefined; };
      },
      onMachinesChanged: (cb: () => void) => {
        changedListener = cb;
        return () => { changedListener = undefined; };
      },
    },
    emitChanged: () => changedListener?.(),
    emitStep: (id: string, step: string) =>
      progressListener?.({ id, event: { event: "machine-install", juntoHome: "/h", installRoot: "/i", step } }),
    finishUpdate: (name: string) => {
      const req = lastCopy(name);
      const item = rows.find((r) => r.machine.id === name);
      if (item) {
        item.setUp = true;
        item.needsUpdate = false;
      }
      pendingUpdates.get(name)?.(
        ok(req, {
          build: BUILD,
          juntoHome: "/h",
          installRoot: "/i",
          directory: "/i/b",
          serviceLabel: "com.junto.core",
          provider: "launchd",
          updated: true,
          disposition: "ready",
          installationId: `inst-${name}`,
          machineName: name,
          pid: 9,
          transitions: [{ step: "verified" }, { step: "quiescent" }, { step: "selected" }, { step: "started" }, { step: "ready" }],
        }),
      );
    },
    refuseUpdate: (name: string, message: string, details: Record<string, unknown>) => {
      const req = lastCopy(name);
      pendingUpdates.get(name)?.(refuse(req, "io", message, details));
    },
    lastCopy,
  };
};

let host: HTMLDivElement;
let root: Root;
let oldApi: typeof window.junto;

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const byTest = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
};
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

const mount = async (owner: ReturnType<typeof makeOwner>) => {
  (window as unknown as { junto: unknown }).junto = owner.api;
  await act(async () => {
    root.render(<><MachinesButton /><ConfirmHost /></>);
    await flush();
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  oldApi = window.junto;
  machines$.set({ loading: false, error: "", items: [], reads: {}, copies: {}, boat: undefined, adding: {}, power: {} });
  state$.canvasName.set("bar-test");
  state$.machinesOpen.set(false);
  state$.machinesRequested.set("");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { root.unmount(); await flush(); });
  host.remove();
  state$.machinesOpen.set(false);
  state$.machinesRequested.set("");
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("opens the popover even when quiet and shows Every machine is ready.", async () => {
  const owner = makeOwner([
    row(THIS_MACHINE, {}, { label: "Studio", isThisMachine: true, sshEndpoint: undefined }),
    row(OTHER_MACHINE, {}, { label: "Mac mini" }),
  ]);
  await mount(owner);
  const trigger = byTest("machines-trigger")!;
  expect(trigger.getAttribute("data-machines-severity")).toBe("quiet");
  expect(trigger.getAttribute("aria-label")).toBe("Machines");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(byTest("machines-trigger-count")).toBeNull();
  expect(byTest("machines-trigger-working")).toBeNull();

  await click(trigger);
  expect(byTest("machines-popover")).toBeTruthy();
  expect(byTest("machines-popover-empty")?.textContent).toBe("Every machine is ready.");
  expect(byTest("machines-popover-update-all")).toBeNull();

  // Open Machines opens the window and closes the popover.
  await click(byTest("machines-popover-open-all"));
  expect(state$.machinesOpen.peek()).toBe(true);
  expect(byTest("machines-popover")).toBeNull();
});

it("refreshes in the background when onMachinesChanged fires and shows working dot + steps", async () => {
  const owner = makeOwner([
    row(THIS_MACHINE, {}, { label: "Studio", isThisMachine: true, sshEndpoint: undefined }),
    row(OTHER_MACHINE, {}, { label: "Mac mini" }),
  ]);
  await mount(owner);
  expect(byTest("machines-trigger")?.getAttribute("data-machines-severity")).toBe("quiet");

  // Push change: Mac mini now needs an update.
  owner.rows[1]!.needsUpdate = true;
  await act(async () => { owner.emitChanged(); await flush(); });
  expect(byTest("machines-trigger")?.getAttribute("data-machines-severity")).toBe("amber");
  expect(byTest("machines-trigger")?.getAttribute("aria-label")).toBe("Machines, 1 needs you");
  expect(byTest("machines-trigger-count")?.textContent).toBe("1");

  // Open popover and trigger Update Junto.
  await click(byTest("machines-trigger"));
  await click(byTest(`machines-popover-action-${OTHER_MACHINE}`));
  expect(byTest("machines-trigger")?.getAttribute("data-machines-severity")).toBe("working");
  expect(byTest("machines-trigger")?.getAttribute("aria-label")).toBe("Machines, updating Junto on Mac mini");
  expect(byTest("machines-trigger-working")).toBeTruthy();
  expect(byTest("machines-trigger-count")).toBeNull();
  // Working row has no action button and updates step progress live.
  expect(byTest(`machines-popover-action-${OTHER_MACHINE}`)).toBeNull();
  await act(async () => { owner.emitStep(owner.lastCopy(OTHER_MACHINE).id, "verified"); await flush(); });
  expect(byTest(`machines-popover-row-${OTHER_MACHINE}`)?.textContent).toContain("Updating Junto, step 2 of 5");

  await act(async () => { owner.finishUpdate(OTHER_MACHINE); await flush(); });
  expect(byTest("machines-popover-empty")?.textContent).toBe("Every machine is ready.");
  expect(byTest("machines-trigger")?.getAttribute("data-machines-severity")).toBe("quiet");
});

it("arms Delete on Boat and Remove on first press, disarms on timeout or blur, and fires on second press", async () => {
  vi.useFakeTimers();
  const owner = makeOwner(
    [
      row(THIS_MACHINE, {}, { label: "Studio", isThisMachine: true, sshEndpoint: undefined }),
      row("boat-bad", {}, { label: "Boat A" }),
      row("boat-gone", {}, { label: "Boat B" }),
    ],
    {
      connected: true,
      machines: [
        { machineName: "boat-bad", sandboxId: "bx_bad0001", size: "small", power: "failed" },
        { machineName: "boat-gone", sandboxId: "bx_gone002", size: "small", power: "gone" },
      ],
    },
  );
  await mount(owner);
  expect(byTest("machines-trigger")?.getAttribute("data-machines-severity")).toBe("crimson");
  expect(byTest("machines-trigger")?.getAttribute("aria-label")).toBe("Machines, 2 cannot work");

  await click(byTest("machines-trigger"));
  const delBtn = byTest("machines-popover-action-boat-bad")!;
  expect(delBtn.textContent).toBe("Delete on Boat");

  // First press arms, does NOT call boat-delete.
  await click(delBtn);
  expect(delBtn.textContent).toBe("Delete Boat A on Boat");
  expect(owner.requests.some((r) => r.op === "machine.boat-delete")).toBe(false);

  // Auto-disarms after KILL_ARM_MS.
  await act(async () => { vi.advanceTimersByTime(KILL_ARM_MS + 10); await flush(); });
  expect(delBtn.textContent).toBe("Delete on Boat");

  // Arm again, then second press fires boat-delete directly.
  await click(delBtn);
  expect(delBtn.textContent).toBe("Delete Boat A on Boat");
  await click(delBtn);
  expect(owner.requests.some((r) => r.op === "machine.boat-delete" && r.args.name === "boat-bad")).toBe(true);

  // Remove arms first, disarms when focus leaves the row, then second press opens the remove dialog directly.
  const removeBtn = byTest("machines-popover-action-boat-gone")!;
  const removeRow = byTest("machines-popover-row-boat-gone")!;
  expect(removeBtn.textContent).toBe("Remove");
  await click(removeBtn);
  expect(removeBtn.textContent).toBe("Remove Boat B");
  await act(async () => {
    removeRow.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    await flush();
  });
  expect(removeBtn.textContent).toBe("Remove");
  await click(removeBtn);
  expect(removeBtn.textContent).toBe("Remove Boat B");
  expect(byTest("confirm-dialog")).toBeNull();
  await click(removeBtn);
  expect(byTest("confirm-dialog")?.textContent).toContain("Remove Boat B?");
  await click(button("Remove machine"));
  expect(owner.requests.some((r) => r.op === "machine.remove" && r.args.name === "boat-gone")).toBe(true);
});

it("offers Update all when two or more idle machines need an update and handles runningSeatsUnknown", async () => {
  const owner = makeOwner([
    row(THIS_MACHINE, {}, { label: "Studio", isThisMachine: true, sshEndpoint: undefined }),
    row("mini-1", { needsUpdate: true }, { label: "Mini 1" }),
    row("mini-2", { needsUpdate: true }, { label: "Mini 2" }),
  ]);
  await mount(owner);
  await click(byTest("machines-trigger"));
  expect(byTest("machines-popover-update-all")).toBeTruthy();

  // Trigger Update all: first machine answers runningSeatsUnknown.
  await click(byTest("machines-popover-update-all"));
  await act(async () => {
    owner.refuseUpdate("mini-1", "could not check running seats", {
      retryable: true,
      disposition: "staged",
      transitions: [],
      runningSeatsUnknown: true,
    });
    await flush();
  });
  expect(byTest("confirm-dialog")?.textContent).toContain("Update Mini 1 now?");
  expect(byTest("confirm-dialog")?.textContent).toContain("Could not check whether seats are running on Mini 1.");
  await click(button("Update now"));
  expect(owner.lastCopy("mini-1").args).toEqual({ name: "mini-1", stopRunningSeats: true });
  await act(async () => { owner.finishUpdate("mini-1"); await flush(); });
  await act(async () => { owner.finishUpdate("mini-2"); await flush(); });
  expect(byTest("machines-popover-empty")?.textContent).toBe("Every machine is ready.");
});
