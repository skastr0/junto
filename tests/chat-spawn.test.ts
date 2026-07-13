import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildAcpSpawnTarget, resolveSessionCwd } from "../src/main/vellum/chat/spawn";

describe("buildAcpSpawnTarget", () => {
  it("local default profile -> `hermes acp`", () => {
    expect(buildAcpSpawnTarget("local:default")).toEqual({
      command: "hermes",
      argv: ["acp"],
      host: "local",
      profile: "default",
    });
  });

  it("local named profile -> `hermes -p <name> acp`", () => {
    expect(buildAcpSpawnTarget("local:profile-13")).toEqual({
      command: "hermes",
      argv: ["-p", "profile-13", "acp"],
      host: "local",
      profile: "profile-13",
    });
  });

  it("remote default profile -> ssh ... remote-a hermes acp", () => {
    expect(buildAcpSpawnTarget("remote-a:default")).toEqual({
      command: "ssh",
      argv: [
        "-o",
        "ConnectTimeout=6",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "remote-a",
        "hermes",
        "acp",
      ],
      host: "remote-a",
      profile: "default",
    });
  });

  it("remote named profile -> ssh ... remote-a hermes -p <name> acp", () => {
    expect(buildAcpSpawnTarget("remote-a:profile-03")).toEqual({
      command: "ssh",
      argv: [
        "-o",
        "ConnectTimeout=6",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "remote-a",
        "hermes",
        "-p",
        "profile-03",
        "acp",
      ],
      host: "remote-a",
      profile: "profile-03",
    });
  });

  it("rejects an invalid agent key instead of building a target", () => {
    expect(buildAcpSpawnTarget("windows:profile-13")).toBeUndefined();
    expect(buildAcpSpawnTarget("local")).toBeUndefined();
    expect(buildAcpSpawnTarget("remote-a:foo; rm -rf")).toBeUndefined();
  });
});

describe("resolveSessionCwd", () => {
  it("local -> the real user home dir", () => {
    expect(resolveSessionCwd("local")).toBe(homedir());
  });

  it("remote-a -> '.', which sshd resolves to the remote user's home dir", () => {
    expect(resolveSessionCwd("remote-a")).toBe(".");
  });
});
