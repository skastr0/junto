import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { StationRole } from "../src/shared/station";
import type { BrowserSessionService } from "../src/main/vellum/browser/sessions";
import type { SshTransport } from "../src/main/vellum/ssh/service";
import {
  admitOperatorUiDelegation,
  mintStationBrowserEnvelope,
} from "../src/main/vellum/browser/station-delegation";
import {
  prepareStationBrowserRuntimeRoutes,
} from "../src/main/vellum/browser/station-runtime";
import { decodeStationBrowserResponse } from "../src/shared/station-browser";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const home = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-station-runtime-"));
  roots.push(root);
  return root;
};

const localHost = {
  id: "local",
  label: "Local",
  kind: "local" as const,
  capabilities: ["browser"] as const,
};
const remoteHost = {
  id: "remote-a",
  label: "Remote A",
  kind: "remote" as const,
  endpoint: "remote-a",
  capabilities: ["browser"] as const,
};

const fakeSsh = {
  run: () => Effect.die(new Error("unexpected SSH")),
} as unknown as typeof SshTransport.Service;

const sessionHarness = (
  initial:
    | Readonly<{ hostId: string; role: StationRole }>
    | undefined,
) => {
  let identity = initial;
  let capable = true;
  const sessions = {
    stationIdentity: () => identity,
    admitAutomationHost: (hostId: string) =>
      capable && identity?.hostId === hostId
        ? { ok: true, host: identity.role === "remote" ? remoteHost : localHost }
        : {
            ok: false,
            code: "unsupported_capability",
            reason: "physical-host-mismatch",
            message: "denied",
          },
  } as unknown as BrowserSessionService;
  return {
    sessions,
    setIdentity: (
      next:
        | Readonly<{ hostId: string; role: StationRole }>
        | undefined,
    ) => {
      identity = next;
    },
    setCapable: (next: boolean) => {
      capable = next;
    },
  };
};

const deps = async (
  sessions: BrowserSessionService,
) => ({
  home: await home(),
  sessions,
  readCanvas: async () => undefined,
  resolvePageTarget: async () => ({
    ok: false as const,
    code: "not_found" as const,
    message: "not found",
  }),
  stationAdmission: { admit: async () => ({ ok: true as const }) },
  hosts: () => [localHost, remoteHost],
  ssh: fakeSsh,
});

describe("station browser production runtime composition", () => {
  it("publishes no route without current physical authority", async () => {
    const missing = sessionHarness(undefined);
    await expect(
      prepareStationBrowserRuntimeRoutes(await deps(missing.sessions)),
    ).resolves.toEqual({});

    const denied = sessionHarness({
      hostId: "local",
      role: "command-center",
    });
    denied.setCapable(false);
    await expect(
      prepareStationBrowserRuntimeRoutes(await deps(denied.sessions)),
    ).resolves.toEqual({});
  });

  it("publishes only the Command Center origin and revokes it on identity drift", async () => {
    const harness = sessionHarness({
      hostId: "local",
      role: "command-center",
    });
    const routes = await prepareStationBrowserRuntimeRoutes(
      await deps(harness.sessions),
    );
    expect(routes.stationBrowserOrigin).toBeDefined();
    expect(routes.stationBrowserWrapper).toBeUndefined();

    harness.setIdentity({ hostId: "remote-a", role: "remote" });
    expect(() =>
      routes.stationBrowserOrigin!.admissionForSocket({} as Socket),
    ).toThrowError(/no longer current/);
  });

  it("publishes only the Remote fixed wrapper and denies when no origin key is pinned", async () => {
    const harness = sessionHarness({
      hostId: "remote-a",
      role: "remote",
    });
    const routes = await prepareStationBrowserRuntimeRoutes(
      await deps(harness.sessions),
    );
    expect(routes.stationBrowserOrigin).toBeUndefined();
    expect(routes.stationBrowserWrapper).toBeDefined();

    const keys = generateKeyPairSync("ed25519");
    const envelope = mintStationBrowserEnvelope(
      admitOperatorUiDelegation("command-a"),
      {
        version: 1,
        requestId: "request-1",
        targetStationId: "remote-a",
        action: "doctor",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 10_000,
        nonce: "nonce-1",
      },
      "untrusted-1",
      keys.privateKey,
    );
    const response = decodeStationBrowserResponse(
      await routes.stationBrowserWrapper!.handle(JSON.stringify(envelope)),
    );
    expect(response).toMatchObject({
      ok: false,
      hostId: "remote-a",
      error: "key",
    });
  });
});
