import { describe, expect, it } from "vitest";
import {
  mergeRemoteStationSettings,
  planRemoteStationConfig,
  planRemoteStationFields,
  remoteStationAlreadyConfigured,
  remoteStationSettingsFromScratch,
} from "../src/shared/remote-station-config";
import { applySettingsPatch, defaultSettings } from "../src/shared/settings";

describe("remote station config planner", () => {
  const input = {
    remoteHostId: "studio",
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
      topologyIntegrity: "ok",
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
      planRemoteStationFields({ remoteHostId: "studio", commandCenterRef: "  " }),
    ).toThrow(/commandCenterRef is required/);
  });

  it("rejects invalid remote host id", () => {
    expect(() =>
      planRemoteStationFields({ remoteHostId: "-bad", commandCenterRef: "local" }),
    ).toThrow(/invalid remote host id/);
  });

  it("rejects an explicitly invalid agent host id", () => {
    expect(() =>
      planRemoteStationFields({
        ...input,
        agentHostId: "-bad",
      }),
    ).toThrow(/invalid agent host id/);
  });

  it("merge preserves non-station sections", () => {
    const current = applySettingsPatch(defaultSettings(), {
      appearance: { theme: "system", reduceMotion: true },
      canvas: { defaultCanvas: "main" },
    });
    const next = mergeRemoteStationSettings(current, input);
    expect(next.appearance.theme).toBe("system");
    expect(next.appearance.reduceMotion).toBe(true);
    expect(next.canvas.defaultCanvas).toBe("main");
    expect(next.station.role).toBe("remote");
    expect(next.station.hostId).toBe("studio");
    expect(next.station.agentHostId).toBe("studio");
    expect(next.station.commandCenterRef).toBe("local");
    expect(next.station.supervisedPreferred).toBe(true);
  });

  it("from-scratch is defaults + remote station stamp", () => {
    const settings = remoteStationSettingsFromScratch(input);
    expect(settings.version).toBe(defaultSettings().version);
    expect(settings.appearance).toEqual(defaultSettings().appearance);
    expect(settings.station.role).toBe("remote");
    expect(settings.station.hostId).toBe("studio");
  });

  it("alreadyConfigured matches planned stamp only", () => {
    const configured = remoteStationSettingsFromScratch(input);
    expect(remoteStationAlreadyConfigured(configured, input)).toBe(true);
    expect(configured.station.topologyIntegrity).toBe("ok");
    expect(
      remoteStationAlreadyConfigured(configured, {
        ...input,
        commandCenterRef: "other",
      }),
    ).toBe(false);
    expect(remoteStationAlreadyConfigured(defaultSettings(), input)).toBe(false);
    expect(
      remoteStationAlreadyConfigured(
        {
          ...configured,
          station: { ...configured.station, topologyIntegrity: "failed" },
        },
        input,
      ),
    ).toBe(false);
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
