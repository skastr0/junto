import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { managedAgentEther } from "./helpers/managed-agent-ether";
import { EMPTY_SETTINGS, state$ } from "../src/renderer/lib/state";

const flushCanvasEdits = vi.fn(async () => undefined);
const getCanvasRevision = vi.fn((_name: string): string | undefined => "rev-1");

vi.mock("../src/renderer/lib/canvas-editor-flush", () => ({
  flushCanvasEdits: () => flushCanvasEdits(),
}));
vi.mock("../src/renderer/lib/mutations", () => ({
  getCanvasRevision: (name: string) => getCanvasRevision(name),
}));

import {
  canToggleOverseer,
  isManagedAgentSeat,
  isOverseerGranted,
  isOverseerSeat,
  OverseerSetError,
  setOverseerSeat,
} from "../src/renderer/lib/overseer-set";

const canvasOverseerSet = vi.fn(async (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly overseer: boolean;
  readonly expectedRevision: string;
}) => ({
  binding: { hostId: "local", bindingId: "bind-worker" },
  overseer: input.overseer,
  affected: [{ name: input.canvasName, revision: "rev-2" }],
}));

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
  getCanvasRevision.mockClear();
  getCanvasRevision.mockReturnValue("rev-1");
  canvasOverseerSet.mockClear();
  state$.settings.set(EMPTY_SETTINGS);
  vi.stubGlobal("window", {
    vellumCommand: { canvasOverseerSet },
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
  it("flushes local edits, then calls canvasOverseerSet with the live revision", async () => {
    const result = await setOverseerSeat({
      canvasName: "Workshop",
      nodeId: "seat",
      overseer: true,
    });
    expect(flushCanvasEdits).toHaveBeenCalledOnce();
    expect(getCanvasRevision).toHaveBeenCalledExactlyOnceWith("Workshop");
    expect(canvasOverseerSet).toHaveBeenCalledExactlyOnceWith({
      canvasName: "Workshop",
      nodeId: "seat",
      overseer: true,
      expectedRevision: "rev-1",
    });
    expect(result.overseer).toBe(true);
    expect(result.affected).toEqual([{ name: "Workshop", revision: "rev-2" }]);
  });

  it("refuses when no revision is loaded", async () => {
    getCanvasRevision.mockReturnValue(undefined);
    await expect(
      setOverseerSeat({ canvasName: "Workshop", nodeId: "seat", overseer: true }),
    ).rejects.toBeInstanceOf(OverseerSetError);
    expect(canvasOverseerSet).not.toHaveBeenCalled();
  });

  it("refuses when the IPC method is absent", async () => {
    vi.stubGlobal("window", { vellumCommand: {} });
    await expect(
      setOverseerSeat({ canvasName: "Workshop", nodeId: "seat", overseer: true }),
    ).rejects.toBeInstanceOf(OverseerSetError);
    expect(flushCanvasEdits).not.toHaveBeenCalled();
  });
});
