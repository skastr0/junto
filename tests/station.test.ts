import { describe, expect, it } from "vitest";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";
import { assessSupervisedRuntime } from "../src/shared/station";
import {
  newSeat,
  newPage,
} from "../src/renderer/lib/model-factories";

describe("node host assignment", () => {
  it("factories stamp host on executable nodes", () => {
    const agent = newSeat({ x: 0, y: 0, z: 0 }, {
      harness: "claude",
      host: THIS_MACHINE,
      profile: "codex",
      label: "codex",
    });
    const page = newPage({ x: 0, y: 0, z: 0 }, "https://example.com", { host: OTHER_MACHINE });
    expect(agent.host).toBe(THIS_MACHINE);
    expect(page.host).toBe(OTHER_MACHINE);
  });

  it("separates an actor's placement HostId from its Hermes routing key", () => {
    const agent = newSeat({ x: 0, y: 0, z: 0 }, {
      harness: "hermes",
      host: "box-1",
      agentHost: "hermes-box",
      profile: "operator",
    });

    expect(agent.host).toBe("box-1");
    expect(agent.agentKey).toBe("hermes-box:operator");
  });

  it("refuses to create an actor without a canonical placement host", () => {
    expect(() =>
      newSeat({ x: 0, y: 0, z: 0 }, {
        harness: "codex",
        host: "",
      }),
    ).toThrow("invalid station host id");
  });

});

describe("supervised runtime assessment", () => {
  it("aligns when preferred and LaunchAgent loaded", () => {
    const result = assessSupervisedRuntime({
      role: "remote",
      hostId: "remote-a",
      supervisedPreferred: true,
      supervisedInstalled: "installed",
    });
    expect(result.aligned).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.metadata.role).toBe("remote");
    expect(result.metadata.hostId).toBe("remote-a");
    expect(result.metadata.supervisedPreferred).toBe("true");
    expect(result.metadata.supervisedInstalled).toBe("installed");
    expect(result.metadata.supervisedAligned).toBe("true");
  });

  it("warns when Remote prefers supervised but agent is absent", () => {
    const result = assessSupervisedRuntime({
      role: "remote",
      hostId: "remote-a",
      supervisedPreferred: true,
      supervisedInstalled: "absent",
    });
    expect(result.aligned).toBe(false);
    expect(result.status).toBe("warning");
    expect(result.detail).toContain("app:install:supervised");
    expect(result.metadata.supervisedAligned).toBe("false");
  });

  it("treats unsupervised preference with absent agent as aligned", () => {
    const result = assessSupervisedRuntime({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
    });
    expect(result.aligned).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("warns when preferred but install state is unknown", () => {
    const result = assessSupervisedRuntime({
      role: "remote",
      hostId: "local",
      supervisedPreferred: true,
      supervisedInstalled: "unknown",
    });
    expect(result.aligned).toBe(false);
    expect(result.status).toBe("warning");
    expect(result.metadata.supervisedInstalled).toBe("unknown");
  });

  it("maps empty role to unset in metadata", () => {
    const result = assessSupervisedRuntime({
      role: "",
      hostId: "local",
      supervisedPreferred: false,
      supervisedInstalled: "absent",
    });
    expect(result.role).toBe("unset");
    expect(result.metadata.role).toBe("unset");
  });
});
