import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import {
  destroyLinuxAdministratorCredential,
  linuxAdministratorCredentialMatches,
  mintLinuxAdministratorCredential,
  takeLinuxAdministratorPasswordLine,
  type LinuxAdministratorCredentialBinding,
} from "../src/main/vellum/hosts/linux-administrator-credential";

const binding = async (
  overrides: Partial<LinuxAdministratorCredentialBinding> = {},
): Promise<LinuxAdministratorCredentialBinding> => ({
  hostId: "studio",
  endpoint: await Effect.runPromise(parseSshEndpoint("studio-box")),
  version: "1.2.3",
  manifestSha256: "a".repeat(64),
  debSha256: "b".repeat(64),
  inventorySha256: "c".repeat(64),
  ...overrides,
});

describe("Linux administrator credential", () => {
  it("is opaque, exact-bound, and consumable only once", async () => {
    const expected = await binding();
    const credential = mintLinuxAdministratorCredential(
      "sentinel-admin-secret",
      expected,
    );

    expect(Object.keys(credential)).toEqual([]);
    expect(JSON.stringify(credential)).toBe("{}");
    expect(String(credential)).not.toContain("sentinel-admin-secret");
    expect(linuxAdministratorCredentialMatches(credential, expected)).toBe(true);
    expect(
      linuxAdministratorCredentialMatches(
        credential,
        await binding({ inventorySha256: "d".repeat(64) }),
      ),
    ).toBe(false);

    const passwordLine = takeLinuxAdministratorPasswordLine(
      credential,
      expected,
    );
    expect(passwordLine.toString("utf8")).toBe("sentinel-admin-secret\n");
    passwordLine.fill(0);
    expect([...passwordLine]).toEqual(
      Array.from({ length: passwordLine.byteLength }, () => 0),
    );
    expect(() =>
      takeLinuxAdministratorPasswordLine(credential, expected),
    ).toThrow(/unavailable/u);
  });

  it("rejects multiline, NUL, empty, oversized, and malformed bindings", async () => {
    const expected = await binding();
    for (const password of [
      "",
      "line one\nline two",
      "line one\rline two",
      "nul\0byte",
      "x".repeat(257),
      "é".repeat(129),
    ]) {
      expect(() =>
        mintLinuxAdministratorCredential(password, expected),
      ).toThrow(/credential is invalid/u);
    }
    const malformed = await binding({ version: "../1.2.3" });
    expect(() =>
      mintLinuxAdministratorCredential("secret", malformed),
    ).toThrow(/binding is invalid/u);
    expect(() =>
      mintLinuxAdministratorCredential("secret", {
        ...expected,
        endpoint: "studio-box\nother" as LinuxAdministratorCredentialBinding["endpoint"],
      }),
    ).toThrow(/binding is invalid/u);
  });

  it("destroys an unused or mismatched capability without exposing its secret", async () => {
    const expected = await binding();
    const credential = mintLinuxAdministratorCredential("do-not-log-me", expected);
    const changed = await binding({ hostId: "other" });
    expect(() =>
      takeLinuxAdministratorPasswordLine(credential, changed),
    ).toThrow("Linux administrator authorization binding changed");
    expect(() =>
      takeLinuxAdministratorPasswordLine(credential, expected),
    ).toThrow("Linux administrator credential is unavailable");

    const unused = mintLinuxAdministratorCredential("also-secret", expected);
    destroyLinuxAdministratorCredential(unused);
    expect(linuxAdministratorCredentialMatches(unused, expected)).toBe(false);
  });
});
