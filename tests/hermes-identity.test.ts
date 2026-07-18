import { describe, expect, it } from "vitest";
import {
  parseIdentityBatchLine,
  parseIdentityBatchOutput,
  readDisplayNameFromContent,
  readEnvFieldFromContent,
} from "../src/main/vellum/adapters/hermes-identity";
import { parseAgentKey } from "../src/main/vellum/hermes/domain";

describe("parseAgentKey", () => {
  it("splits a valid local key", () => {
    expect(parseAgentKey("local:profile-13")).toEqual({ host: "local", profile: "profile-13" });
  });

  it("splits a valid remote-a key", () => {
    expect(parseAgentKey("remote-a:profile-03")).toEqual({ host: "remote-a", profile: "profile-03" });
  });

  it("accepts the default profile", () => {
    expect(parseAgentKey("local:default")).toEqual({ host: "local", profile: "default" });
  });

  it("accepts any well-formed host id (membership is registry-checked at use)", () => {
    expect(parseAgentKey("windows:profile-13")).toEqual({ host: "windows", profile: "profile-13" });
    expect(parseAgentKey("fleet-1:agent")).toEqual({ host: "fleet-1", profile: "agent" });
  });

  it("rejects a missing profile segment", () => {
    expect(parseAgentKey("local:")).toBeUndefined();
  });

  it("rejects a key with no colon", () => {
    expect(parseAgentKey("local")).toBeUndefined();
  });

  it("rejects a profile with shell metacharacters", () => {
    expect(parseAgentKey("remote-a:foo; rm -rf")).toBeUndefined();
    expect(parseAgentKey("remote-a:foo'bar")).toBeUndefined();
    expect(parseAgentKey("remote-a:foo bar")).toBeUndefined();
  });
});

describe("readDisplayNameFromContent", () => {
  it("extracts the display name/code line", () => {
    expect(readDisplayNameFromContent("- Display name/code: PROFILE-13\nOther stuff")).toBe("PROFILE-13");
  });

  it("returns undefined when the line is absent", () => {
    expect(readDisplayNameFromContent("no such field here")).toBeUndefined();
  });
});

describe("readEnvFieldFromContent", () => {
  const env = [
    "MATRIX_USER_ID=@profile-13:remote-a.example.ts.net",
    "MATRIX_ACCESS_TOKEN=syt_super_secret_value",
    "MATRIX_DEVICE_ID=ABCDEF1234",
    "MATRIX_HOME_ROOM=!roomid:remote-a.example.ts.net",
    "MATRIX_HOME_ROOM_NAME=PROFILE-13 — Repositories",
  ].join("\n");

  it("extracts the whitelisted matrixUserId field", () => {
    expect(readEnvFieldFromContent(env, "MATRIX_USER_ID")).toBe(
      "@profile-13:remote-a.example.ts.net",
    );
  });

  it("extracts the whitelisted homeRoomName field", () => {
    expect(readEnvFieldFromContent(env, "MATRIX_HOME_ROOM_NAME")).toBe("PROFILE-13 — Repositories");
  });

  it("returns undefined for a missing key", () => {
    expect(readEnvFieldFromContent(env, "NOT_PRESENT")).toBeUndefined();
  });

  it("only ever extracts the two whitelisted keys the adapter calls it with", () => {
    // The production adapter (readEnvFields) calls this helper with exactly
    // MATRIX_USER_ID and MATRIX_HOME_ROOM_NAME — never with a secret key.
    // This fixture's other lines (MATRIX_ACCESS_TOKEN, MATRIX_DEVICE_ID,
    // MATRIX_HOME_ROOM) exist only to prove those call sites still resolve
    // the right value when secret lines are interleaved in the same file.
    expect(readEnvFieldFromContent(env, "MATRIX_USER_ID")).toBe(
      "@profile-13:remote-a.example.ts.net",
    );
    expect(readEnvFieldFromContent(env, "MATRIX_HOME_ROOM_NAME")).toBe("PROFILE-13 — Repositories");
  });
});

describe("parseIdentityBatchLine", () => {
  it("parses a fully populated tab-separated line", () => {
    const line = "profile-13\tPROFILE-13\t@profile-13:remote-a.ts.net\tPROFILE-13 — Repositories\ttrue";
    expect(parseIdentityBatchLine(line)).toEqual({
      profile: "profile-13",
      identity: {
        displayName: "PROFILE-13",
        matrixUserId: "@profile-13:remote-a.ts.net",
        homeRoomName: "PROFILE-13 — Repositories",
        hasAvatar: true,
      },
    });
  });

  it("maps empty fields to undefined", () => {
    const line = "profile-14\t\t\t\tfalse";
    expect(parseIdentityBatchLine(line)).toEqual({
      profile: "profile-14",
      identity: {
        displayName: undefined,
        matrixUserId: undefined,
        homeRoomName: undefined,
        hasAvatar: false,
      },
    });
  });

  it("rejects a line with too few columns", () => {
    expect(parseIdentityBatchLine("default\t\t")).toBeUndefined();
  });
});

describe("parseIdentityBatchOutput", () => {
  it("parses multiple lines into a profile -> identity map, skipping blanks", () => {
    const stdout = [
      "default\t\t@hermes:remote-a.ts.net\t\ttrue",
      "",
      "profile-13\tPROFILE-13\t@profile-13:remote-a.ts.net\tPROFILE-13 — Repositories\ttrue",
      "profile-14\t\t\t\tfalse",
    ].join("\n");

    const identities = parseIdentityBatchOutput(stdout, "fleet-1");
    expect(identities.size).toBe(3);
    expect(identities.get("profile-13")).toEqual({
      key: "fleet-1:profile-13",
      displayName: "PROFILE-13",
      matrixUserId: "@profile-13:remote-a.ts.net",
      homeRoomName: "PROFILE-13 — Repositories",
      hasAvatar: true,
    });
    expect(identities.get("profile-14")?.hasAvatar).toBe(false);
  });
});
