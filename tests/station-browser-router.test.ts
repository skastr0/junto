import { generateKeyPairSync } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeOperatorStationBrowserRouteAdmission,
} from "../src/main/vellum/browser/station-delegation";
import {
  decodeStationBrowserRouteInput,
  makeStationBrowserRouter,
  StationBrowserRouterError,
  STATION_BROWSER_MAX_REMOTE_CONCURRENCY_PER_HOST,
  type StationBrowserRouterDeps,
} from "../src/main/vellum/browser/station-router";
import type { StationBrowserResponse } from "../src/shared/station-browser";
import type { SshTransport } from "../src/main/vellum/ssh/service";

const keys = generateKeyPairSync("ed25519");
const pageRef = "vellum://canvas/work?node=page-1";
const localHost = {
  id: "command-a",
  label: "Command A",
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
const admission = () =>
  makeOperatorStationBrowserRouteAdmission("command-a");

const okResponse = (
  request: {
    readonly requestId: string;
    readonly action: "doctor" | "open";
    readonly targetStationId: string;
  },
): StationBrowserResponse =>
  request.action === "doctor"
    ? {
        version: 1,
        requestId: request.requestId,
        action: "doctor",
        ok: true,
        hostId: request.targetStationId,
        data: { role: request.targetStationId === "command-a" ? "command-center" : "remote", browserReady: true },
      }
    : {
        version: 1,
        requestId: request.requestId,
        action: "open",
        ok: true,
        hostId: request.targetStationId,
        data: {
          session: {
            hostId: request.targetStationId,
            sessionId: "session-1",
            generation: "generation-1",
          },
        },
      };

const baseDeps = (
  changes: Partial<StationBrowserRouterDeps> = {},
): StationBrowserRouterDeps => ({
  stationId: "command-a",
  hosts: () => [localHost, remoteHost],
  resolvePageHost: async () => ({ hostId: "remote-a" }),
  local: {
    execute: async (request) =>
      okResponse(request as Parameters<typeof okResponse>[0]),
  },
  ssh: {
    run: () =>
      Effect.die(new Error("unexpected raw SSH call")),
  } as unknown as typeof SshTransport.Service,
  signingIdentity: async () => ({
    keyId: "fleet-1",
    privateKey: keys.privateKey,
  }),
  now: () => 1_700_000_000_000,
  requestId: () => "request-1",
  nonce: () => "nonce-1",
  ...changes,
});

describe("station browser host-qualified router", () => {
  it("keeps the local branch on the existing local client and never loads signing authority", async () => {
    let localCalls = 0;
    let signingCalls = 0;
    let remoteCalls = 0;
    const router = makeStationBrowserRouter(baseDeps({
      resolvePageHost: async () => ({ hostId: "command-a" }),
      local: {
        execute: async (request) => {
          localCalls += 1;
          return okResponse(request as Parameters<typeof okResponse>[0]);
        },
      },
      signingIdentity: async () => {
        signingCalls += 1;
        return { keyId: "fleet-1", privateKey: keys.privateKey };
      },
      dispatchRemote: () => {
        remoteCalls += 1;
        return Effect.die(new Error("unexpected"));
      },
    }));

    await expect(router.route(admission(), { action: "open", pageRef }))
      .resolves.toMatchObject({ ok: true, hostId: "command-a" });
    expect({ localCalls, signingCalls, remoteCalls }).toEqual({
      localCalls: 1,
      signingCalls: 0,
      remoteCalls: 0,
    });
  });

  it("derives a Remote from current page truth and dispatches a fresh signed request", async () => {
    const seen: Array<{
      readonly target: string;
      readonly requestId: string;
      readonly issuedAt: number;
      readonly keyId: string;
    }> = [];
    const router = makeStationBrowserRouter(baseDeps({
      dispatchRemote: (_ssh, _hosts, envelope) => {
        seen.push({
          target: envelope.request.targetStationId,
          requestId: envelope.request.requestId,
          issuedAt: envelope.request.issuedAt,
          keyId: envelope.keyId,
        });
        return Effect.succeed(okResponse(envelope.request as Parameters<typeof okResponse>[0]));
      },
    }));

    await expect(router.route(admission(), {
      action: "open",
      pageRef,
      targetHostId: "remote-a",
    })).resolves.toMatchObject({
      ok: true,
      hostId: "remote-a",
      data: { session: { hostId: "remote-a", generation: "generation-1" } },
    });
    expect(seen).toEqual([{
      target: "remote-a",
      requestId: "request-1",
      issuedAt: 1_700_000_000_000,
      keyId: "fleet-1",
    }]);
  });

  it("admits only the derived target and rechecks document host truth before signing", async () => {
    let currentHost = "remote-a";
    let remoteCalls = 0;
    const admitted: unknown[] = [];
    const operator = admission();
    const router = makeStationBrowserRouter(baseDeps({
      resolvePageHost: async () => ({ hostId: currentHost }),
      dispatchRemote: () => {
        remoteCalls += 1;
        return Effect.die(new Error("unexpected"));
      },
    }));
    const routeAdmission = {
      preflight: async () => undefined,
      admit: async (
        target: Parameters<typeof operator.admit>[0],
        signal?: AbortSignal,
      ) => {
        admitted.push(target);
        const value = await operator.admit(target, signal);
        currentHost = "other";
        return value;
      },
    };

    await expect(router.route(routeAdmission, {
      action: "open",
      pageRef,
    })).rejects.toMatchObject({ code: "stale_page" });
    expect(admitted).toEqual([{
      targetStationId: "remote-a",
      pageRef,
    }]);
    expect(remoteCalls).toBe(0);
  });

  it("rejects caller host assertions, mixed sessions, unknown hosts, and removed capability before transport", async () => {
    let calls = 0;
    const dispatchRemote: NonNullable<StationBrowserRouterDeps["dispatchRemote"]> =
      () => {
        calls += 1;
        return Effect.die(new Error("unexpected"));
      };
    const router = makeStationBrowserRouter(baseDeps({ dispatchRemote }));
    await expect(router.route(admission(), {
      action: "open",
      pageRef,
      targetHostId: "remote-b",
    })).rejects.toMatchObject({ code: "wrong_host" });
    await expect(router.route(admission(), {
      action: "state",
      pageRef,
      session: {
        hostId: "remote-b",
        sessionId: "session-1",
        generation: "generation-1",
      },
    })).rejects.toMatchObject({ code: "wrong_host" });

    const unknown = makeStationBrowserRouter(baseDeps({
      hosts: () => [localHost],
      dispatchRemote,
    }));
    await expect(unknown.route(admission(), {
      action: "open",
      pageRef,
    })).rejects.toMatchObject({ code: "unknown_host" });

    const removed = makeStationBrowserRouter(baseDeps({
      hosts: () => [{ ...remoteHost, capabilities: ["hermes"] }],
      dispatchRemote,
    }));
    await expect(removed.route(admission(), {
      action: "open",
      pageRef,
    })).rejects.toMatchObject({ code: "host_capability" });
    expect(calls).toBe(0);
  });

  it("fails closed on wrong-host and malformed remote replies", async () => {
    for (const response of [
      {
        version: 1,
        requestId: "request-1",
        action: "doctor",
        ok: true,
        hostId: "other",
        data: { role: "remote", browserReady: true },
      },
      {
        version: 1,
        requestId: "other",
        action: "doctor",
        ok: true,
        hostId: "remote-a",
        data: { role: "remote", browserReady: true },
      },
    ] as const) {
      const router = makeStationBrowserRouter(baseDeps({
        dispatchRemote: () => Effect.succeed(response as StationBrowserResponse),
      }));
      await expect(router.route(admission(), {
        action: "doctor",
        targetHostId: "remote-a",
      })).rejects.toMatchObject({ code: "malformed_response" });
    }
  });

  it("interrupts only the scoped Remote operation when the caller cancels", async () => {
    let acquired = 0;
    let released = 0;
    let unrelated = 0;
    const router = makeStationBrowserRouter(baseDeps({
      dispatchRemote: () =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            acquired += 1;
            return {};
          }),
          () => Effect.never,
          () => Effect.sync(() => {
            released += 1;
          }),
        ),
    }));
    const controller = new AbortController();
    const routed = router.route(
      admission(),
      { action: "doctor", targetHostId: "remote-a" },
      controller.signal,
    );
    while (acquired === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(routed).rejects.toMatchObject({ code: "cancelled" });
    expect({ acquired, released, unrelated }).toEqual({
      acquired: 1,
      released: 1,
      unrelated: 0,
    });
  });

  it("bounds concurrent Remote operations per physical host", async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sequence = 0;
    const router = makeStationBrowserRouter(baseDeps({
      requestId: () => `request-${++sequence}`,
      nonce: () => `nonce-${sequence}`,
      dispatchRemote: (_ssh, _hosts, envelope) =>
        Effect.promise(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate;
          active -= 1;
          return okResponse(envelope.request as Parameters<typeof okResponse>[0]);
        }),
    }));
    const calls = Array.from({ length: 5 }, () =>
      router.route(admission(), {
        action: "doctor",
        targetHostId: "remote-a",
      }),
    );
    while (peak < STATION_BROWSER_MAX_REMOTE_CONCURRENCY_PER_HOST) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(peak).toBe(STATION_BROWSER_MAX_REMOTE_CONCURRENCY_PER_HOST);
    release();
    await expect(Promise.all(calls)).resolves.toHaveLength(5);
  });
});

describe("station browser origin-route decoder", () => {
  it("accepts only typed station actions and rejects wrapper/path/bounds injection", () => {
    expect(decodeStationBrowserRouteInput({
      action: "open",
      pageRef,
      targetHostId: "remote-a",
    })).toMatchObject({ ok: true });
    expect(decodeStationBrowserRouteInput({
      action: "goto",
      pageRef,
      session: {
        hostId: "remote-a",
        sessionId: "session-1",
        generation: "generation-1",
      },
      payload: { url: "https://example.com/next" },
    })).toMatchObject({ ok: true });
    for (const value of [
      { action: "setBounds", pageRef },
      { action: "open", pageRef, path: "/tmp/browser.sock" },
      { action: "open", pageRef, program: "bash" },
      { action: "doctor", targetHostId: "remote-a", forward: 9222 },
      {
        action: "goto",
        pageRef,
        session: {
          hostId: "remote-a",
          sessionId: "session-1",
          generation: "generation-1",
        },
        payload: { url: "https://example.com", code: "x" },
      },
    ]) {
      expect(decodeStationBrowserRouteInput(value)).toEqual({ ok: false });
    }
  });
});
