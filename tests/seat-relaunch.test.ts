import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasOf, seat as modelSeat } from "./support/model-nodes";
import { planSeatLaunch } from "../src/shared/seat-launch-params";

vi.mock("../src/renderer/lib/mutations", () => ({
  commitCommands: vi.fn(),
  flushPendingCanvasSave: vi.fn(async () => undefined),
}));
vi.mock("../src/renderer/lib/terminal-actions", () => ({
  ensureTerminalRunning: vi.fn(),
  killTerminal: vi.fn(),
  openTerminal: vi.fn(),
}));
vi.mock("../src/renderer/lib/junto-api", () => ({ getJuntoApi: vi.fn() }));

import { getJuntoApi } from "../src/renderer/lib/junto-api";
import { commitCommands, flushPendingCanvasSave } from "../src/renderer/lib/mutations";
import { performSeatRelaunch } from "../src/renderer/lib/seat-relaunch";
import { ensureTerminalRunning, killTerminal, openTerminal } from "../src/renderer/lib/terminal-actions";

const params = { mode: "low", extraArgs: ["--features", "plaid", "--no-color"] };
const seat = modelSeat("amp-seat", {
  label: "Reviewer" as never,
  agentKey: "local:amp" as never,
  bindingId: "amp-binding" as never,
  harness: "amp",
  sessionId: "T-00000000-0000-4000-8000-000000000001" as never,
  launch: planSeatLaunch({ harness: "amp", params, base: { cwd: "/work" } }).launch as never,
});

beforeEach(() => vi.clearAllMocks());

describe("Amp parameter changes before restart", () => {
  it.each([
    { ...params, mode: "high" },
    { ...params, extraArgs: ["--fast", "--no-color"] },
  ])("refuses a thread-owned change before reading, saving or stopping anything", async (next) => {
    const before = structuredClone(seat);
    expect(await performSeatRelaunch(seat, next)).toMatchObject({ ok: false });
    expect(getJuntoApi).not.toHaveBeenCalled();
    expect(commitCommands).not.toHaveBeenCalled();
    expect(flushPendingCanvasSave).not.toHaveBeenCalled();
    expect(killTerminal).not.toHaveBeenCalled();
    expect(ensureTerminalRunning).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
    expect(seat).toEqual(before);
  });

  it("allows client options to be saved without replacing the Amp thread", async () => {
    const result = await performSeatRelaunch(seat, {
      ...params,
      extraArgs: ["--features", "plaid", "--no-notifications"],
    });
    expect(result).toEqual({ ok: true, restarted: false, rejected: [] });
    // What is sent is one edit of the seat's launch: the binding and the
    // session are not in it, so they stay as they were.
    expect(commitCommands).toHaveBeenCalledOnce();
    const edit = vi.mocked(commitCommands).mock.calls[0]![0];
    expect(edit(canvasOf([seat]))).toEqual([
      {
        _tag: "Edit",
        canvas: "factory",
        id: "amp-seat",
        change: {
          kind: "agent",
          launch: expect.objectContaining({ extraArgs: ["--features", "plaid", "--no-notifications"] }),
        },
      },
    ]);
    expect(flushPendingCanvasSave).toHaveBeenCalledOnce();
    expect(killTerminal).not.toHaveBeenCalled();
  });
});
