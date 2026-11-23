// @vitest-environment jsdom
/**
 * Inline broken-machine recovery card for stopped remote seats: pure recovery
 * mapping, copy law, in-place progress steps, and reopening once the fix lands.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { SeatMachineRecoveryCard } from "../src/window/components/machines/SeatMachineRecoveryCard";
import { machines$ } from "../src/window/lib/machines-actions";
import { seatMachineRecovery } from "../src/window/lib/seat-machine-recovery";
import { seatDeadReason } from "../src/window/lib/seat-recovery";
import { state$ } from "../src/window/lib/state";
import type { MachineCopy, MachineListItem, MachineRead } from "../src/window/lib/machines-view";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

const item = (more: Partial<MachineListItem> = {}, machine: Record<string, unknown> = {}): MachineListItem => ({
  machine: { id: OTHER_MACHINE, label: "Mac mini", isThisMachine: false, capabilities: ["terminal"], sshEndpoint: "op@mini", ...machine },
  setUp: true,
  needsUpdate: false,
  installationId: "inst-mini" as MachineListItem["installationId"],
  ...more,
});

const peerRead = (more: Record<string, unknown> = {}): MachineRead => ({
  kind: "peer",
  status: {
    machineName: OTHER_MACHINE,
    reachable: true,
    harnesses: [{ harness: "claude", installed: true, signIn: "sign-in-unverified" }],
    missingSecrets: [],
    ...more,
  },
});

const baseInput = () => ({
  host: OTHER_MACHINE,
  harness: "claude",
  thisName: THIS_MACHINE,
  machines: [
    { id: THIS_MACHINE, label: "Studio" },
    { id: OTHER_MACHINE, label: "Mac mini" },
  ],
  facts: { [OTHER_MACHINE]: { setUp: true, needsUpdate: false } },
  items: [item()],
  reads: { [OTHER_MACHINE]: peerRead() },
  copies: {} as Record<string, MachineCopy>,
  boat: undefined,
  power: {} as Record<string, "wake" | "sleep">,
});

describe("seatDeadReason for remote machines", () => {
  it("names the remote machine for cli-missing instead of this machine", () => {
    expect(seatDeadReason({ reason: "cli-missing", machine: "Mac mini" })).toBe(
      "the harness is not installed on Mac mini",
    );
    expect(seatDeadReason({ reason: "cli-missing" })).toBe(
      "the harness is not installed on this machine",
    );
  });
});

describe("seatMachineRecovery", () => {
  it("returns undefined for this machine and for healthy remote machines", () => {
    expect(seatMachineRecovery({ ...baseInput(), host: THIS_MACHINE })).toBeUndefined();
    expect(seatMachineRecovery(baseInput())).toBeUndefined();
  });

  it("maps every blocking machine condition with the approved look copy and non-repeating detail", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input: Parameters<typeof seatMachineRecovery>[0];
      readonly eyebrow: "stopped" | "asleep";
      readonly eyebrowTone: "amber" | "steel";
      readonly severity: "broken" | "needs-you" | "asleep";
      readonly actionLabel: string;
    }> = [
      {
        name: "not-listed",
        input: { ...baseInput(), host: "unknown-box" },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Add machine",
      },
      {
        name: "not-set-up",
        input: { ...baseInput(), items: [item({ setUp: false })], reads: {} },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Send Junto",
      },
      {
        name: "installed-not-linked",
        input: { ...baseInput(), items: [item({ setUp: false, setupState: "installed-not-linked" })], reads: {} },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Reconnect",
      },
      {
        name: "needs-update",
        input: { ...baseInput(), items: [item({ needsUpdate: true })], reads: {} },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Update Junto",
      },
      {
        name: "peer-newer",
        input: { ...baseInput(), items: [item({ needsUpdate: true, updateDirection: "this-older" })], reads: {} },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Check for updates",
      },
      {
        name: "asleep",
        input: {
          ...baseInput(),
          reads: {},
          boat: {
            connected: true,
            unrevokedKeyIds: [],
            machines: [{ machineName: OTHER_MACHINE, sandboxId: "bx_1", size: "small", power: "asleep" }],
          },
        },
        eyebrow: "asleep",
        eyebrowTone: "steel",
        severity: "asleep",
        actionLabel: "Wake",
      },
      {
        name: "unreachable",
        input: { ...baseInput(), reads: { [OTHER_MACHINE]: peerRead({ reachable: false, harnesses: [] }) } },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "broken",
        actionLabel: "Check again",
      },
      {
        name: "update-stopped",
        input: {
          ...baseInput(),
          copies: {
            [OTHER_MACHINE]: {
              kind: "failed",
              op: "update",
              id: "u1",
              message: "start failed",
              steps: ["verified", "quiescent", "selected"],
              disposition: "activated",
              installed: false,
            },
          },
        },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "broken",
        actionLabel: "Reinstall Junto",
      },
      {
        name: "harness-missing",
        input: { ...baseInput(), harness: "codex" },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Check again",
      },
      {
        name: "keychain-blocked",
        input: {
          ...baseInput(),
          reads: {
            [OTHER_MACHINE]: peerRead({
              harnesses: [{ harness: "claude", installed: true, signIn: "keychain-login-unavailable" }],
            }),
          },
        },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Check again",
      },
      {
        name: "missing-secrets",
        input: {
          ...baseInput(),
          reads: { [OTHER_MACHINE]: peerRead({ missingSecrets: ["GH_TOKEN"] }) },
        },
        eyebrow: "stopped",
        eyebrowTone: "amber",
        severity: "needs-you",
        actionLabel: "Check again",
      },
    ];

    for (const c of cases) {
      const recovery = seatMachineRecovery(c.input);
      expect(recovery, c.name).toBeDefined();
      expect(recovery!.eyebrow, c.name).toBe(c.eyebrow);
      expect(recovery!.eyebrowTone, c.name).toBe(c.eyebrowTone);
      expect(recovery!.severity, c.name).toBe(c.severity);
      expect(recovery!.action.label, c.name).toBe(c.actionLabel);
      // Headline carries machine label once; detail does not repeat it; zero middots.
      expect(recovery!.headline, c.name).toContain(recovery!.label);
      expect(recovery!.detail, c.name).not.toContain(recovery!.label);
      expect(`${recovery!.headline} ${recovery!.detail}`, c.name).not.toContain("\u00B7");
    }
  });
});

describe("SeatMachineRecoveryCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let oldApi: typeof window.junto;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    oldApi = window.junto;
    machines$.set({ loading: false, error: "", items: [], reads: {}, copies: {}, boat: undefined, adding: {}, power: {} });
    state$.machinesOpen.set(false);
    state$.machinesRequested.set("");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); await flush(); });
    host.remove();
    (window as unknown as { junto: unknown }).junto = oldApi;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders inline steps while updating and reopens the seat when update completes", async () => {
    const onReopen = vi.fn();
    const onCloseView = vi.fn();
    const recovery = seatMachineRecovery({
      ...baseInput(),
      items: [item({ needsUpdate: true })],
      reads: {},
    })!;

    (window as unknown as { junto: unknown }).junto = {
      machineCommand: vi.fn(async (req: { id: string; op: string }) => {
        if (req.op === "machine.update") {
          return {
            protocol: OPERATOR_PROTOCOL_VERSION,
            id: req.id,
            op: req.op,
            ok: true,
            data: {
              build: "a".repeat(64),
              juntoHome: "/h",
              installRoot: "/i",
              directory: "/i/b",
              serviceLabel: "com.junto.core",
              provider: "launchd",
              updated: true,
              disposition: "ready",
              installationId: "inst-mini",
              machineName: OTHER_MACHINE,
              pid: 5,
              transitions: [{ step: "verified" }, { step: "quiescent" }, { step: "selected" }, { step: "started" }, { step: "ready" }],
            },
          };
        }
        if (req.op === "machine.list") {
          return { protocol: OPERATOR_PROTOCOL_VERSION, id: req.id, op: req.op, ok: true, data: { machines: [item()] } };
        }
        return { protocol: OPERATOR_PROTOCOL_VERSION, id: req.id, op: req.op, ok: false, error: { type: "validation", message: "no" } };
      }),
    };

    await act(async () => {
      root.render(
        <SeatMachineRecoveryCard recovery={recovery} grid={false} onReopen={onReopen} onCloseView={onCloseView} />,
      );
      await flush();
    });

    expect(document.querySelector('[data-testid="seat-machine-recovery-card"]')?.textContent).toContain("Mac mini needs an update");
    expect(document.querySelector('[data-testid="seat-machine-recovery-close"]')).toBeTruthy();

    // Clicking Open Machines opens Machines on that machine.
    await act(async () => {
      document.querySelector('[data-testid="seat-machine-recovery-open-machines"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(state$.machinesOpen.peek()).toBe(true);
    expect(state$.machinesRequested.peek()).toBe(OTHER_MACHINE);

    // Clicking Update Junto runs the update and calls onReopen.
    await act(async () => {
      document.querySelector('[data-testid="seat-machine-recovery-action"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });
    expect(onReopen).toHaveBeenCalledTimes(1);

    // While running, inline steps show and button is disabled.
    const runningRecovery = seatMachineRecovery({
      ...baseInput(),
      items: [item({ needsUpdate: true })],
      reads: {},
      copies: { [OTHER_MACHINE]: { kind: "running", op: "update", id: "u2", steps: ["verified"] } },
    })!;
    await act(async () => {
      root.render(
        <SeatMachineRecoveryCard recovery={runningRecovery} grid={true} onReopen={onReopen} onCloseView={onCloseView} />,
      );
      await flush();
    });
    expect(document.querySelector('[data-testid="seat-machine-recovery-steps"]')?.className).toContain("machine-steps--inline");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="seat-machine-recovery-action"]')?.disabled).toBe(true);
    expect(document.querySelector('[data-testid="seat-machine-recovery-close"]')).toBeNull();
  });
});
