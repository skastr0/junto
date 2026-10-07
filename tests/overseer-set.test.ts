import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { managedAgentEther } from "./helpers/managed-agent-ether";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";

const flushCanvasEdits = vi.fn(async () => undefined);

vi.mock("../src/renderer/lib/canvas-editor-flush", () => ({
  flushCanvasEdits: () => flushCanvasEdits(),
}));

import {
  canToggleOverseer,
  isManagedAgentSeat,
  isOverseerGranted,
  isOverseerSeat,
  OverseerSetError,
  setOverseerSeat,
} from "../src/renderer/lib/overseer-set";

const modelCommand = vi.fn(async (_command: unknown) => ({ seq: 1 }));

const managedSeat = (): CanvasNode =>
  ({
    id: "seat",
    type: "text",
    text: "worker",
    x: 0,
    y: 0,
    width: 240,
    height: 96,
    ether: managedAgentEther("local:worker"),
  }) as CanvasNode;

beforeEach(() => {
  flushCanvasEdits.mockClear();
  modelCommand.mockClear();
  modelCommand.mockResolvedValue({ seq: 1 });
  state$.settings.set(EMPTY_SETTINGS);
  vi.stubGlobal("window", {
    junto: { modelCommand },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("overseer seat eligibility", () => {
  it("is only a managed executable agent seat", () => {
    expect(isManagedAgentSeat(managedSeat())).toBe(true);
    expect(
      isManagedAgentSeat({
        ...managedSeat(),
        ether: { entity: { kind: "agent", name: "edge" } },
      } as CanvasNode),
    ).toBe(false);
    expect(
      isManagedAgentSeat({
        id: "note",
        type: "text",
        text: "note",
        x: 0,
        y: 0,
        width: 120,
        height: 80,
      } as CanvasNode),
    ).toBe(false);
  });

  it("treats only ether.overseer true as granted", () => {
    expect(isOverseerGranted(managedSeat())).toBe(false);
    expect(
      isOverseerGranted({
        ...managedSeat(),
        ether: { ...managedAgentEther("local:worker"), overseer: true },
      } as CanvasNode),
    ).toBe(true);
    expect(
      isOverseerGranted({
        ...managedSeat(),
        ether: { ...managedAgentEther("local:worker"), overseer: false },
      } as CanvasNode),
    ).toBe(false);
    expect(
      isOverseerSeat({
        ...managedSeat(),
        ether: { ...managedAgentEther("local:worker"), overseer: true },
      } as CanvasNode),
    ).toBe(true);
    expect(
      isOverseerSeat({
        id: "note",
        type: "text",
        text: "note",
        x: 0,
        y: 0,
        width: 120,
        height: 80,
        ether: { overseer: true },
      } as CanvasNode),
    ).toBe(false);
  });

  it("hides the human toggle on Remote stations", () => {
    state$.settings.station.role.set("command-center");
    expect(canToggleOverseer(managedSeat())).toBe(true);
    state$.settings.station.role.set("remote");
    expect(canToggleOverseer(managedSeat())).toBe(false);
  });
});

describe("setOverseerSeat", () => {
  it("commits local edits, then sends the grant as its own command", async () => {
    await setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: true });
    expect(flushCanvasEdits).toHaveBeenCalledOnce();
    expect(modelCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: "GrantOverseer",
      canvas: "workshop",
      id: "seat",
      overseer: true,
    });
    expect(flushCanvasEdits.mock.invocationCallOrder[0]).toBeLessThan(modelCommand.mock.invocationCallOrder[0]!);
  });

  it("sends a revoke the same way", async () => {
    await setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: false });
    expect(modelCommand).toHaveBeenCalledExactlyOnceWith({
      _tag: "GrantOverseer",
      canvas: "workshop",
      id: "seat",
      overseer: false,
    });
  });

  it("passes on main's refusal", async () => {
    modelCommand.mockRejectedValueOnce(new Error("Only the operator changes overseer authority"));
    await expect(
      setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: true }),
    ).rejects.toThrow("Only the operator");
  });

  it("refuses when the IPC method is absent", async () => {
    vi.stubGlobal("window", { junto: {} });
    await expect(
      setOverseerSeat({ canvasName: "workshop", nodeId: "seat", overseer: true }),
    ).rejects.toBeInstanceOf(OverseerSetError);
    expect(flushCanvasEdits).not.toHaveBeenCalled();
  });
});
