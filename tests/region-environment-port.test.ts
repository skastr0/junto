/**
 * The screen's port bound to main: a bridge that lacks a method answers in
 * words, and a failure never repeats what was thrown (an IPC error can quote
 * its arguments, and one of them is a secret).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge: { current: Record<string, unknown> | undefined } = { current: undefined };
vi.mock("../src/renderer/lib/junto-api", () => ({ getJuntoApi: () => bridge.current }));

const { regionEnvironmentPort } = await import("../src/renderer/lib/region-environment-port");

afterEach(() => {
  bridge.current = undefined;
});

describe("regionEnvironmentPort", () => {
  it("says what it cannot do when the bridge has no such method, or there is no bridge", async () => {
    const port = regionEnvironmentPort();
    expect(await port.report("r1")).toEqual({ ok: false, message: "This build of Junto cannot do that yet." });
    bridge.current = {};
    expect(await port.restartSeat("s1")).toEqual({ ok: false, message: "This build of Junto cannot do that yet." });
  });

  it("passes each call through to its bridge method with its arguments", async () => {
    const saveSecret = vi.fn(async () => ({ ok: true as const, secretId: "sec-1" }));
    const report = vi.fn(async () => ({ ok: true as const, report: [] }));
    bridge.current = { regionEnvSaveSecret: saveSecret, regionEnvReport: report };
    const port = regionEnvironmentPort();
    expect(await port.saveSecret({ regionId: "r1", name: "K", value: "v" })).toEqual({ ok: true, secretId: "sec-1" });
    expect(saveSecret).toHaveBeenCalledWith({ regionId: "r1", name: "K", value: "v" });
    expect(await port.report("r1")).toEqual({ ok: true, report: [] });
    expect(report).toHaveBeenCalledWith("r1");
  });

  it("never repeats a thrown error, which could quote the secret it was given", async () => {
    bridge.current = {
      regionEnvSaveSecret: async (input: { value: string }) => {
        throw new Error(`invoke failed with args ${JSON.stringify(input)}`);
      },
    };
    const result = await regionEnvironmentPort().saveSecret({ regionId: "r1", name: "K", value: "hunter2" });
    expect(result).toEqual({ ok: false, message: "Junto could not complete that. Try again." });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
