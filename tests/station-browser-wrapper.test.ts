import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeStationBrowserResponse } from "../src/shared/station-browser";
import { admitOperatorUiDelegation, mintStationBrowserEnvelope, StationBrowserReplayCache } from "../src/main/vellum/browser/station-delegation";
import { makeStationBrowserWrapper } from "../src/main/vellum/browser/station-wrapper";

const keys = generateKeyPairSync("ed25519");
const request = () => JSON.stringify(mintStationBrowserEnvelope(admitOperatorUiDelegation("command-a"), { version: 1, requestId: "request-1", targetStationId: "remote-a", action: "doctor", issuedAt: 1_700_000_000_000, expiresAt: 1_700_000_030_000, nonce: "nonce-1" }, "fleet-1", keys.privateKey));
const context = () => ({ stationId: "remote-a", now: 1_700_000_001_000, role: "remote" as const, browserReady: true, resolvePage: () => ({ hostId: "remote-a", edgeAllowed: true, policyAllowed: true }), currentGeneration: () => "generation", allowAction: () => true });

describe("station browser target wrapper", () => {
  it("verifies a signed host-bound delegation before target-local execution", async () => {
    let calls = 0;
    const wrapper = makeStationBrowserWrapper({ trust: { keyId: "fleet-1", publicKey: keys.publicKey, originStationId: "command-a" }, verification: context, replays: new StationBrowserReplayCache(), execute: async () => { calls += 1; return { role: "remote", browserReady: true }; } });
    expect(decodeStationBrowserResponse(await wrapper.handle(request()))).toMatchObject({ ok: true, hostId: "remote-a" });
    expect(calls).toBe(1);
  });
  it("never executes expired or replayed delegations", async () => {
    let calls = 0;
    const wrapper = makeStationBrowserWrapper({ trust: { keyId: "fleet-1", publicKey: keys.publicKey, originStationId: "command-a" }, verification: context, replays: new StationBrowserReplayCache(), execute: async () => { calls += 1; return { role: "remote", browserReady: true }; } });
    const frame = request();
    await wrapper.handle(frame);
    expect(decodeStationBrowserResponse(await wrapper.handle(frame))).toMatchObject({ ok: false, error: "replayed" });
    expect(calls).toBe(1);
  });
});
