import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAcpSpawnTarget, resolveSessionCwd } from "../src/main/vellum-command/chat/spawn";

describe("buildAcpSpawnTarget", () => {
  it("parses a local default ACP intent", () => {
    expect(buildAcpSpawnTarget("local:default")).toEqual({
      host: "local",
      profile: "default",
    });
  });

  it("parses a local named ACP intent", () => {
    expect(buildAcpSpawnTarget("local:profile-13")).toEqual({
      host: "local",
      profile: "profile-13",
    });
  });

  it("parses a remote default ACP intent", () => {
    expect(buildAcpSpawnTarget("remote-a:default")).toEqual({
      host: "remote-a",
      profile: "default",
    });
  });

  it("parses a remote named ACP intent", () => {
    expect(buildAcpSpawnTarget("remote-a:profile-03")).toEqual({
      host: "remote-a",
      profile: "profile-03",
    });
  });

  it("rejects an invalid agent key instead of building a target", () => {
    // Well-formed remote keys are accepted here; registry membership is
    // enforced when the host is resolved for SSH.
    expect(buildAcpSpawnTarget("fleet-1:profile-13")).toEqual({
      host: "fleet-1",
      profile: "profile-13",
    });
    expect(buildAcpSpawnTarget("local")).toBeUndefined();
    expect(buildAcpSpawnTarget("remote-a:foo; rm -rf")).toBeUndefined();
  });
});

describe("resolveSessionCwd", () => {
  it("local -> the real user home dir", () => {
    expect(resolveSessionCwd(true)).toBe(homedir());
  });

  it("remote-a -> '.', which sshd resolves to the remote user's home dir", () => {
    expect(resolveSessionCwd(false)).toBe(".");
  });
});
