import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import type {
  HostsDeployRemoteAuthorizationRequest,
  HostsDeployRemoteInput,
} from "../src/shared/ipc";
import {
  decodeHostsDeployRemoteInput,
  withHostsDeployRemoteAuthorization,
} from "../src/main/vellum/hosts/ipc";
import {
  linuxAdministratorCredentialMatches,
  type LinuxAdministratorCredential,
  type LinuxAdministratorCredentialBinding,
} from "../src/main/vellum/hosts/linux-administrator-credential";

const sha = (character: string): string => character.repeat(64);

const request = (): HostsDeployRemoteAuthorizationRequest => ({
  kind: "linux-administrator-password",
  hostId: "studio",
  endpoint: "vellum@studio-box",
  version: "1.2.3",
  manifestSha256: sha("a"),
  debSha256: sha("b"),
  inventorySha256: sha("c"),
});

const binding = (
  value: HostsDeployRemoteAuthorizationRequest,
): LinuxAdministratorCredentialBinding => ({
  hostId: value.hostId,
  endpoint:
    value.endpoint as LinuxAdministratorCredentialBinding["endpoint"],
  version: value.version,
  manifestSha256: value.manifestSha256,
  debSha256: value.debSha256,
  inventorySha256: value.inventorySha256,
});

const input = (
  password = "one-attempt-secret",
): HostsDeployRemoteInput => ({
  id: "studio",
  authorization: {
    request: request(),
    password,
  },
});

describe("Linux administrator deployment authorization", () => {
  it("decodes and binds every public request fact exactly", async () => {
    const serialized = input();
    const decoded = decodeHostsDeployRemoteInput(serialized);
    if (decoded === undefined || !("authorization" in decoded)) {
      throw new Error("authorization did not decode");
    }

    let credential: LinuxAdministratorCredential | undefined;
    const result = await Effect.runPromise(
      withHostsDeployRemoteAuthorization(decoded, (authorization) =>
        Effect.sync(() => {
          expect(authorization?.kind).toBe("linux-administrator-password");
          if (authorization?.kind !== "linux-administrator-password") {
            throw new Error("opaque authorization missing");
          }
          credential = authorization.credential;
          expect(
            linuxAdministratorCredentialMatches(
              authorization.credential,
              binding(decoded.authorization.request),
            ),
          ).toBe(true);
          expect(
            linuxAdministratorCredentialMatches(
              authorization.credential,
              binding({
                ...decoded.authorization.request,
                inventorySha256: sha("d"),
              }),
            ),
          ).toBe(false);
          return "used";
        }),
      ),
    );

    expect(result).toBe("used");
    expect(credential).toBeDefined();
    expect(
      linuxAdministratorCredentialMatches(
        credential,
        binding(decoded.authorization.request),
      ),
    ).toBe(false);
  });

  it("destroys an unconsumed credential when the sole attempt fails", async () => {
    const decoded = decodeHostsDeployRemoteInput(input());
    if (decoded === undefined || !("authorization" in decoded)) {
      throw new Error("authorization did not decode");
    }

    let credential: LinuxAdministratorCredential | undefined;
    const exit = await Effect.runPromiseExit(
      withHostsDeployRemoteAuthorization(decoded, (authorization) => {
        if (authorization?.kind === "linux-administrator-password") {
          credential = authorization.credential;
        }
        return Effect.fail("deployment-failed" as const);
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(credential).toBeDefined();
    expect(
      linuxAdministratorCredentialMatches(
        credential,
        binding(decoded.authorization.request),
      ),
    ).toBe(false);
  });

  it("refuses an invalid password before invoking deployment", async () => {
    const decoded = decodeHostsDeployRemoteInput(input("line-one\nline-two"));
    if (decoded === undefined) throw new Error("structural decode failed");
    const use = vi.fn(() => Effect.succeed("deployed"));

    const exit = await Effect.runPromiseExit(
      withHostsDeployRemoteAuthorization(decoded, use),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(use).not.toHaveBeenCalled();
  });
});
