import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_TOKEN_HEADER,
  STATION_BROWSER_ORIGIN_ROUTE_PATH,
  controlSocketPath,
  controlTokenPath,
} from "../src/shared/browser-control";
import {
  startBrowserControlServer,
  type BrowserControlServer,
} from "../src/main/vellum/browser/control";
import {
  StationBrowserOriginAdmissionError,
  admitOperatorUiDelegation,
  type StationBrowserDelegationTarget,
  type StationBrowserRouteAdmission,
} from "../src/main/vellum/browser/station-delegation";
import type { StationBrowserRouter } from "../src/main/vellum/browser/station-router";
import type { BrowserCapabilityRegistry } from "../src/main/vellum/browser/capabilities";
import type { EdgeGrantService } from "../src/main/vellum/browser/edge-grant";
import type { BrowserSessionService } from "../src/main/vellum/browser/sessions";

const roots: string[] = [];
const servers: BrowserControlServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const post = (
  home: string,
  token: string,
  body: string,
  requestId: string | null = randomUUID(),
): Promise<Readonly<{ status: number; body: unknown }>> =>
  new Promise((resolvePost, rejectPost) => {
    const req = request(
      {
        socketPath: controlSocketPath(home),
        method: "POST",
        path: STATION_BROWSER_ORIGIN_ROUTE_PATH,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          [CONTROL_TOKEN_HEADER]: token,
          ...(requestId === null
            ? {}
            : { [CONTROL_REQUEST_ID_HEADER]: requestId }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolvePost({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.once("error", rejectPost);
    req.end(body);
  });

const start = async (
  admission: StationBrowserRouteAdmission,
  routed: Array<unknown>,
): Promise<Readonly<{ home: string; token: string; edgeCalls: () => number }>> => {
  const home = await mkdtemp("/tmp/vso-");
  roots.push(home);
  let edgeCalls = 0;
  const edgeGrant = {
    processMap: {},
    admitSocket: async () => {
      edgeCalls += 1;
      return {
        ok: false as const,
        denial: "process_unbound" as const,
        message: "ordinary edge grant must not handle station routes",
      };
    },
    admitPrincipal: async () => ({
      ok: false as const,
      denial: "process_unbound" as const,
      message: "unused",
    }),
    clear: () => undefined,
  } as unknown as EdgeGrantService;
  const router = {
    route: async (
      admitted: StationBrowserRouteAdmission,
      input: {
        readonly action: "doctor";
        readonly targetHostId: string;
      },
      signal?: AbortSignal,
    ) => {
      routed.push(input);
      await admitted.admit(
        { targetStationId: input.targetHostId },
        signal,
      );
      return {
        version: 1 as const,
        requestId: "remote-request-1",
        action: "doctor" as const,
        ok: true as const,
        hostId: input.targetHostId,
        data: { role: "remote" as const, browserReady: true },
      };
    },
  } as unknown as StationBrowserRouter;
  const server = await startBrowserControlServer({
    sessions: {} as BrowserSessionService,
    capabilities: {} as BrowserCapabilityRegistry,
    resolvePageTarget: async () => ({
      ok: false,
      code: "not_found",
      message: "unused",
    }),
    version: "test",
    home,
    edgeGrant,
    listCanvasDocuments: async () => [],
    stationBrowserOrigin: {
      router,
      admissionForSocket: () => admission,
    },
  });
  servers.push(server);
  return {
    home,
    token: (await readFile(controlTokenPath(home), "utf8")).trim(),
    edgeCalls: () => edgeCalls,
  };
};

describe("host-qualified station browser origin control route", () => {
  it("process-binds before routing and does not pass through the local EdgeGrant", async () => {
    const events: string[] = [];
    const operator = {
      preflight: async () => {
        events.push("preflight");
      },
      admit: async (
        target: StationBrowserDelegationTarget,
      ) => {
        events.push(`admit:${target.targetStationId}`);
        return admitOperatorUiDelegation("command-a", target);
      },
    };
    const routed: unknown[] = [];
    const stack = await start(operator, routed);

    const result = await post(
      stack.home,
      stack.token,
      JSON.stringify({ action: "doctor", targetHostId: "remote-a" }),
    );
    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true,
        data: {
          response: {
            ok: true,
            hostId: "remote-a",
            action: "doctor",
          },
        },
      },
    });
    expect(events).toEqual(["preflight", "admit:remote-a"]);
    expect(routed).toEqual([{
      action: "doctor",
      targetHostId: "remote-a",
    }]);
    expect(stack.edgeCalls()).toBe(0);
  });

  it("fails closed before body parsing when socket process admission is denied", async () => {
    const routed: unknown[] = [];
    const stack = await start({
      preflight: async () => {
        throw new StationBrowserOriginAdmissionError(
          "process_unbound",
          "private detail",
        );
      },
      admit: async () => {
        throw new Error("unreachable");
      },
    }, routed);
    const result = await post(stack.home, stack.token, "{not-json");
    expect(result).toMatchObject({
      status: 401,
      body: {
        ok: false,
        error: {
          _tag: "unauthorized",
          message: "station browser origin admission failed",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private detail");
    expect(routed).toEqual([]);
  });

  it("rejects missing request ids and non-protocol fields without routing", async () => {
    const routed: unknown[] = [];
    const stack = await start({
      preflight: async () => undefined,
      admit: async (target) =>
        admitOperatorUiDelegation("command-a", target),
    }, routed);
    const missingId = await post(
      stack.home,
      stack.token,
      JSON.stringify({ action: "doctor", targetHostId: "remote-a" }),
      null,
    );
    expect(missingId).toMatchObject({
      status: 400,
      body: { ok: false, error: { _tag: "bad_request" } },
    });
    const injected = await post(
      stack.home,
      stack.token,
      JSON.stringify({
        action: "doctor",
        targetHostId: "remote-a",
        program: "bash",
      }),
    );
    expect(injected).toMatchObject({
      status: 400,
      body: { ok: false, error: { _tag: "bad_request" } },
    });
    expect(routed).toEqual([]);
  });
});
