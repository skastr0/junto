// @vitest-environment jsdom
/**
 * The Machines window against a fake owner: it reads and acts only through
 * the closed owner machine commands, shows each machine's state in plain
 * words, and never asks for a second way to a machine.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { MachinesWindow } from "../src/renderer/components/machines/MachinesWindow";
import { machines$ } from "../src/renderer/lib/machines-actions";
import { state$ } from "../src/renderer/lib/state";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

vi.hoisted(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

const BUILD = "a".repeat(64);
type Request = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> };
type Listed = { machine: Record<string, unknown>; setUp: boolean; needsUpdate: boolean; installationId?: string };

const row = (id: string, more: Partial<Listed> = {}, machine: Record<string, unknown> = {}): Listed => ({
  machine: { id, label: id, isThisMachine: false, capabilities: ["terminal"], sshEndpoint: `op@${id}`, ...machine },
  setUp: true,
  needsUpdate: false,
  installationId: `inst-${id}`,
  ...more,
});

/** Main, as far as the window can tell: it answers the closed commands and nothing else. */
const fakeOwner = () => {
  const rows: Listed[] = [
    row(THIS_MACHINE, {}, { label: "Studio", isThisMachine: true, sshEndpoint: undefined }),
    row(OTHER_MACHINE, {}, { label: "Atlas" }),
    row("build-box", { setUp: false, installationId: undefined }),
    row("mini", { needsUpdate: true }),
    row("ghost"),
  ];
  const requests: Request[] = [];
  let listener: ((payload: unknown) => void) | undefined;
  /** A send waits here until the test lets it finish. */
  const copies = new Map<string, (answer: unknown) => void>();
  const ok = (request: Request, data: unknown) =>
    ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
  const refuse = (request: Request, type: string, message: string, details: Record<string, unknown> = {}) =>
    ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false, error: { type, message, details } });
  const listedRows = () =>
    rows.map(({ machine, installationId, ...rest }) => ({
      machine: Object.fromEntries(Object.entries(machine).filter(([, value]) => value !== undefined)),
      ...rest,
      ...(installationId === undefined ? {} : { installationId }),
    }));
  const harnesses = [{ harness: "claude", installed: true }, { harness: "codex", installed: false }];
  const machineCommand = vi.fn(async (request: Request): Promise<unknown> => {
    requests.push(request);
    const name = request.args.name as string | undefined;
    switch (request.op) {
      case "machine.list":
        return ok(request, { machines: listedRows() });
      case "machine.status":
        if (name === undefined) {
          return ok(request, {
            build: BUILD, form: "macbook", installationId: `inst-${THIS_MACHINE}`, machineName: THIS_MACHINE,
            juntoHome: "/Users/op/.junto", pid: 41, ready: true,
          });
        }
        if (name === "ghost") {
          return ok(request, { machineName: name, reachable: false, harnesses: [], missingSecrets: [], detail: "SSH did not answer" });
        }
        return ok(request, {
          machineName: name, reachable: true, form: "mac-mini", installationId: `inst-${name}`, harnesses,
          missingSecrets: name === OTHER_MACHINE ? ["ANTHROPIC_API_KEY", "GH_TOKEN"] : [],
        });
      case "machine.harnesses":
        return ok(request, { machineName: THIS_MACHINE, reachable: true, harnesses });
      case "machine.add": {
        if (rows.some((entry) => entry.machine.id === name)) return refuse(request, "conflict", "A machine with this name is already here");
        rows.push(row(name!, { setUp: false, installationId: undefined }, { sshEndpoint: request.args.sshTarget, label: request.args.label ?? name }));
        return ok(request, listedRows().at(-1)!.machine);
      }
      case "machine.send":
      case "machine.update":
        return new Promise((resolve) => copies.set(name!, resolve));
      case "machine.remove": {
        const index = rows.findIndex((entry) => entry.machine.id === name);
        rows.splice(index, 1);
        return ok(request, { machineName: name, removed: true });
      }
      default:
        return refuse(request, "validation", "unsupported machine operation");
    }
  });
  return {
    api: {
      machineCommand,
      onMachineProgress: (next: (payload: unknown) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
    },
    requests,
    rows,
    ops: () => requests.map((request) => request.op),
    last: (op: string) => requests.filter((request) => request.op === op).at(-1)!,
    step: (id: string, step: string) =>
      listener?.({ id, event: { event: "machine-install", juntoHome: "/home/op/.junto", installRoot: "/home/op/.junto-install", step } }),
    emit: (payload: unknown) => listener?.(payload),
    /** The copy to `name` succeeds: the machine is now set up on this build. */
    finishCopy: (name: string) => {
      const request = requests.filter((entry) => entry.args.name === name && (entry.op === "machine.send" || entry.op === "machine.update")).at(-1)!;
      const entry = rows.find((candidate) => candidate.machine.id === name)!;
      entry.setUp = true; entry.needsUpdate = false; entry.installationId = `inst-${name}`;
      copies.get(name)!(ok(request, {
        build: BUILD, juntoHome: "/home/op/.junto", installRoot: "/home/op/.junto-install", directory: "/home/op/.junto-install/builds/a",
        serviceLabel: "com.junto.core", provider: "systemd-user", updated: request.op === "machine.update", disposition: "ready",
        installationId: `inst-${name}`, machineName: name, pid: 77,
        transitions: [{ step: "verified" }, { step: "quiescent" }, { step: "selected" }, { step: "started" }, { step: "ready" }],
      }));
    },
    failCopy: (name: string, message: string) => {
      const request = requests.filter((entry) => entry.args.name === name && entry.op !== "machine.status").at(-1)!;
      copies.get(name)!(refuse(request, "io", message, {
        retryable: false, disposition: "staged", transitions: [{ step: "verified" }],
      }));
    },
  };
};

let host: HTMLDivElement;
let root: Root;
let owner: ReturnType<typeof fakeOwner>;
let oldApi: typeof window.junto;

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const settle = async () => act(async () => { await flush(); });
const byTest = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const condition = (name: string) => byTest(`machine-row-${name}`)?.getAttribute("data-machine-condition");
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => { element!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); });
};
const select = async (name: string) => click(byTest(`machine-row-${name}`));
const type = async (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** The add dialog's own button; the window's header has one with the same words. */
const submitAdd = () => byTest("machine-add")?.querySelector<HTMLButtonElement>('button[type="submit"]');
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  owner = fakeOwner();
  oldApi = window.junto;
  (window as unknown as { junto: unknown }).junto = owner.api;
  machines$.set({ loading: false, error: "", items: [], reads: {}, copies: {} });
  state$.canvasName.set("machines-window");
  state$.machinesOpen.set(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<MachinesWindow />); await flush(); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); await flush(); });
  host.remove();
  state$.machinesOpen.set(false); state$.canvasName.set(""); state$.machines.set([]);
  (window as unknown as { junto: unknown }).junto = oldApi;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("lists every machine with the state it is in, this machine first", async () => {
  const names = [...document.querySelectorAll('[data-testid^="machine-row-"]')].map((element) => element.getAttribute("data-testid"));
  expect(names).toEqual([
    `machine-row-${THIS_MACHINE}`, `machine-row-${OTHER_MACHINE}`, "machine-row-build-box", "machine-row-ghost", "machine-row-mini",
  ]);
  expect(condition(THIS_MACHINE)).toBe("this-machine");
  expect(condition(OTHER_MACHINE)).toBe("ready");
  expect(condition("build-box")).toBe("not-set-up");
  expect(condition("mini")).toBe("needs-update");
  expect(condition("ghost")).toBe("unreachable");
  expect(byTest("machines-status")?.textContent).toBe("5 machines, 3 need you");
  // The pickers on the canvas read the same list.
  expect(state$.machines.peek().map((machine) => machine.id)).toContain("build-box");
});

it("asks only a machine that can answer: not one without Junto, not one on another build", () => {
  const asked = owner.requests.filter((request) => request.op === "machine.status").map((request) => request.args.name);
  expect(asked).toEqual(expect.arrayContaining([undefined, OTHER_MACHINE, "ghost"]));
  expect(asked).not.toContain("build-box");
  expect(asked).not.toContain("mini");
});

it("shows this machine's build and harnesses, and no way to remove it", () => {
  const detail = byTest("machine-detail")!;
  expect(detail.getAttribute("data-machine")).toBe(THIS_MACHINE);
  expect(detail.textContent).toContain(BUILD.slice(0, 12));
  expect([...byTest("machine-harnesses")!.children].map((item) => item.textContent)).toEqual(["Claude Code: found", "Codex: not found"]);
  expect(byTest("machine-action-remove")).toBeNull();
});

it("names a machine's missing secrets and shows no value", async () => {
  await select(OTHER_MACHINE);
  expect(byTest("machine-missing-secrets")?.textContent).toContain("ANTHROPIC_API_KEY, GH_TOKEN");
  expect(byTest("machine-headline")?.textContent).toBe("Ready");
});

it("says why a machine cannot be reached and what to do", async () => {
  await select("ghost");
  expect(byTest("machine-headline")?.textContent).toBe("Cannot reach this machine");
  expect(byTest("machine-advice")?.textContent).toBe("SSH did not answer");
});

it("sends Junto with one command, shows its steps, then reads the list again", async () => {
  await select("build-box");
  expect(byTest("machine-headline")?.textContent).toBe("Added. Junto is not on it yet.");
  await click(byTest("machine-action-send"));
  const sent = owner.last("machine.send");
  // The name only: main picks the build this machine runs, and sets the machine up.
  expect(sent.args).toEqual({ name: "build-box" });
  expect(condition("build-box")).toBe("sending");
  expect(byTest("machine-action-send")).toBeNull();

  await act(async () => { owner.step(sent.id, "verified"); owner.step(sent.id, "quiescent"); await flush(); });
  const done = () => [...byTest("machine-steps")!.querySelectorAll('[data-done="true"]')].map((item) => item.getAttribute("data-step"));
  expect(done()).toEqual(["verified", "quiescent"]);
  // A step for another command, or one that is not a step, lands nowhere.
  await act(async () => { owner.step("window-other", "ready"); owner.emit({ id: sent.id, event: { step: "ready", secret: "value" } }); await flush(); });
  expect(done()).toEqual(["verified", "quiescent"]);

  await act(async () => { owner.finishCopy("build-box"); await flush(); });
  await settle();
  expect(condition("build-box")).toBe("ready");
  expect(byTest("machine-steps")).toBeNull();
  expect(owner.ops()).not.toContain("machine.setup");
});

it("says why a send failed, keeps how far it got, and offers it again", async () => {
  await select("build-box");
  await click(byTest("machine-action-send"));
  await act(async () => { owner.failCopy("build-box", "This Junto has no build for a Linux machine"); await flush(); });
  expect(condition("build-box")).toBe("send-failed");
  expect(byTest("machine-headline")?.textContent).toBe("Junto could not be sent");
  expect(byTest("machine-advice")?.textContent).toBe("This Junto has no build for a Linux machine");
  expect(byTest("machine-steps")!.querySelector('[data-step="verified"]')?.getAttribute("data-done")).toBe("true");
  expect(byTest("machine-action-send")).not.toBeNull();
});

it("updates a machine on another build with one command", async () => {
  await select("mini");
  expect(byTest("machine-headline")?.textContent).toBe("Runs a different build of Junto");
  await click(byTest("machine-action-update"));
  expect(owner.last("machine.update").args).toEqual({ name: "mini" });
  expect(condition("mini")).toBe("updating");
  await act(async () => { owner.finishCopy("mini"); await flush(); });
  await settle();
  expect(condition("mini")).toBe("ready");
});

it("adds a machine by name and SSH target, and shows the owner's refusal as it is", async () => {
  await click(byTest("machines-add"));
  await type("Machine name", OTHER_MACHINE);
  await type("SSH target", "op@atlas.example");
  await click(submitAdd());
  expect(byTest("machine-add-error")?.textContent).toBe("A machine with this name is already here");

  await type("Machine name", "nuc");
  await type("Machine label", "Shelf box");
  await click(submitAdd());
  expect(owner.last("machine.add").args).toEqual({ name: "nuc", sshTarget: "op@atlas.example", label: "Shelf box" });
  expect(byTest("machine-add")).toBeNull();
  expect(condition("nuc")).toBe("not-set-up");
  expect(byTest("machine-detail")?.getAttribute("data-machine")).toBe("nuc");
});

it("will not add a machine called local, or one with no SSH target", async () => {
  await click(byTest("machines-add"));
  await type("Machine name", "local");
  await type("SSH target", "op@somewhere");
  expect(submitAdd()?.disabled).toBe(true);
  await type("Machine name", "nuc");
  await type("SSH target", "  ");
  expect(submitAdd()?.disabled).toBe(true);
  expect(owner.ops()).not.toContain("machine.add");
});

it("removes a machine only after the operator confirms", async () => {
  await select(OTHER_MACHINE);
  await click(byTest("machine-action-remove"));
  expect(byTest("machine-remove")?.textContent).toContain("Remove Atlas?");
  expect(owner.ops()).not.toContain("machine.remove");
  await click(button("Remove machine"));
  expect(owner.last("machine.remove").args).toEqual({ name: OTHER_MACHINE });
  expect(byTest(`machine-row-${OTHER_MACHINE}`)).toBeNull();
  expect(byTest("machine-remove")).toBeNull();
});

it("reaches machines through the owner commands and nothing else", async () => {
  await select("ghost");
  await click(byTest("machine-action-check"));
  expect(new Set(owner.ops())).toEqual(new Set(["machine.list", "machine.status", "machine.harnesses"]));
  for (const request of owner.requests) {
    expect(Object.keys(request).sort()).toEqual(["args", "id", "op", "protocol"]);
    expect(request.id).toMatch(/^window-[0-9A-Z]{26}$/);
  }
  expect(Object.keys(owner.api).sort()).toEqual(["machineCommand", "onMachineProgress"]);
});
