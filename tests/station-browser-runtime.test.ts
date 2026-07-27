import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { Effect, Schema, type Context } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { StationRole } from "../src/shared/station";
import type { BrowserSessionService } from "../src/main/vellum/browser/sessions";
import type { SshTransport } from "../src/main/vellum/ssh/service";
import {
  admitOperatorUiDelegation,
  mintStationBrowserEnvelope,
  type StationBrowserTrust,
} from "../src/main/vellum/browser/station-delegation";
import {
  prepareStationBrowserRuntimeRoutes,
} from "../src/main/vellum/browser/station-runtime";
import {
  StationBrowserTrustRepository,
  type StationBrowserOriginKey,
} from "../src/main/vellum/browser/station-trust";
import { decodeStationBrowserResponse } from "../src/shared/station-browser";
import { InstallationId } from "../src/shared/station-api";

const roots: string[] = [];
const commandInstallationId = Schema.decodeUnknownSync(InstallationId)(
  "11111111-1111-4111-8111-111111111111",
);
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

const trustHarness = (
  pinned?: StationBrowserTrust,
) => {
  const pair = generateKeyPairSync("ed25519");
  const originKey = {
    generation: 1,
    keyId: "ed25519-test-origin",
    originInstallationId: commandInstallationId,
    createdAt: 1,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  } as StationBrowserOriginKey;
  let originLoads = 0;
  const loadedInstallationIds: string[] = [];
  let pinnedLoads = 0;
  const service = StationBrowserTrustRepository.of({
    loadOrCreateOriginKey: (originInstallationId) =>
      Effect.sync(() => {
        originLoads += 1;
        loadedInstallationIds.push(originInstallationId);
        if (originInstallationId !== commandInstallationId) {
          throw new Error("origin key requested for the wrong installation");
        }
        return originKey;
      }),
    rotateOriginKey: () =>
      Effect.die(new Error("unexpected key rotation")),
    readPinnedRecord: Effect.succeed(undefined),
    installPinnedRecord: () =>
      Effect.die(new Error("unexpected pin install")),
    loadPinnedTrust: Effect.sync(() => {
      pinnedLoads += 1;
      return pinned;
    }),
  });
  return {
    service,
    originLoads: () => originLoads,
    loadedInstallationIds: () => loadedInstallationIds,
    pinnedLoads: () => pinnedLoads,
  };
};

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
  trust: Context.Tag.Service<typeof StationBrowserTrustRepository>,
) => ({
  home: await home(),
  installationId: commandInstallationId,
  trust,
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
    const missingTrust = trustHarness();
    await expect(
      prepareStationBrowserRuntimeRoutes(
        await deps(missing.sessions, missingTrust.service),
      ),
    ).resolves.toEqual({});
    expect(missingTrust.originLoads()).toBe(0);
    expect(missingTrust.pinnedLoads()).toBe(0);

    const denied = sessionHarness({
      hostId: "local",
      role: "command-center",
    });
    const deniedTrust = trustHarness();
    denied.setCapable(false);
    await expect(
      prepareStationBrowserRuntimeRoutes(
        await deps(denied.sessions, deniedTrust.service),
      ),
    ).resolves.toEqual({});
    expect(deniedTrust.originLoads()).toBe(0);
  });

  it("reopens the installation-bound Command Center origin across restart and revokes it on host identity drift", async () => {
    const harness = sessionHarness({
      hostId: "local",
      role: "command-center",
    });
    const trust = trustHarness();
    const routes = await prepareStationBrowserRuntimeRoutes(
      await deps(harness.sessions, trust.service),
    );
    expect(routes.stationBrowserOrigin).toBeDefined();
    expect(routes.stationBrowserWrapper).toBeUndefined();
    expect(trust.originLoads()).toBe(1);
    expect(trust.loadedInstallationIds()).toEqual([commandInstallationId]);

    const restarted = sessionHarness({
      hostId: "local",
      role: "command-center",
    });
    const restartedRoutes = await prepareStationBrowserRuntimeRoutes(
      await deps(restarted.sessions, trust.service),
    );
    expect(restartedRoutes.stationBrowserOrigin).toBeDefined();
    expect(trust.originLoads()).toBe(2);
    expect(trust.loadedInstallationIds()).toEqual([
      commandInstallationId,
      commandInstallationId,
    ]);

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
    const trust = trustHarness();
    const routes = await prepareStationBrowserRuntimeRoutes(
      await deps(harness.sessions, trust.service),
    );
    expect(routes.stationBrowserOrigin).toBeUndefined();
    expect(routes.stationBrowserWrapper).toBeDefined();
    expect(trust.pinnedLoads()).toBe(1);

    const keys = generateKeyPairSync("ed25519");
    const envelope = mintStationBrowserEnvelope(
      admitOperatorUiDelegation(commandInstallationId),
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
    expect(trust.pinnedLoads()).toBe(2);
  });
});
