import { describe, expect, it } from "vitest";
import {
  planRemoteStationConfig,
  planRemoteStationFields,
} from "../src/shared/remote-station-config";

describe("remote station config planner", () => {
  const input = {
    remoteHostId: "studio",
    agentHostId: "studio",
    commandCenterRef: "local",
  } as const;

  it("plans Remote station fields with supervisedPreferred default true", () => {
    const station = planRemoteStationFields(input);
    expect(station).toEqual({
      role: "remote",
      hostId: "studio",
      agentHostId: "studio",
      commandCenterRef: "local",
      supervisedPreferred: true,
    });
  });

  it("honors supervisedPreferred override", () => {
    const station = planRemoteStationFields({
      ...input,
      supervisedPreferred: false,
    });
    expect(station.supervisedPreferred).toBe(false);
  });

  it("keeps a distinct configured Hermes identity separate from physical hostId", () => {
    const station = planRemoteStationFields({
      ...input,
      agentHostId: "fleet-studio",
    });
    expect(station.hostId).toBe("studio");
    expect(station.agentHostId).toBe("fleet-studio");
  });

  it("rejects empty commandCenterRef", () => {
    expect(() =>
      planRemoteStationFields({
        remoteHostId: "studio",
        agentHostId: "studio",
        commandCenterRef: "  ",
      }),
    ).toThrow(/commandCenterRef is required/);
  });

  it("rejects invalid remote host id", () => {
    expect(() =>
      planRemoteStationFields({
        remoteHostId: "-bad",
        agentHostId: "studio",
        commandCenterRef: "local",
      }),
    ).toThrow(/invalid remote host id/);
  });

  it("requires the canonical Hermes identity instead of inferring hostId", () => {
    expect(() =>
      planRemoteStationFields({
        remoteHostId: "studio",
        commandCenterRef: "local",
      } as never),
    ).toThrow(/invalid agent host id/);
  });

  it("rejects an explicitly invalid agent host id", () => {
    expect(() =>
      planRemoteStationFields({
        ...input,
        agentHostId: "-bad",
      }),
    ).toThrow(/invalid agent host id/);
  });

  it("plan summary is glanceable", () => {
    const plan = planRemoteStationConfig(input);
    expect(plan.summary).toContain("role=remote");
    expect(plan.summary).toContain("hostId=studio");
    expect(plan.summary).toContain("agentHostId=studio");
    expect(plan.summary).toContain("commandCenterRef=local");
    expect(plan.summary).toContain("supervisedPreferred=true");
  });
});
