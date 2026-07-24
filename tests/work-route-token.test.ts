import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitWorkIdentity,
  workTokenMatches,
} from "../src/main/vellum/work/control";
import {
  CONTROL_DIRECTORY_MODE,
  CONTROL_FILE_MODE,
  generateRouteTokenPlaintext,
  hashRouteToken,
  loadRouteTokenRecord,
  mintRouteToken,
  revokeRouteToken,
  rotateRouteToken,
  routeTokenHashEquals,
  resolveRouteToken,
  resolveRouteTokenDetailed,
  RouteTokenError,
} from "../src/main/vellum/work/route-tokens";
import type { ProcessPrincipal } from "../src/main/vellum/process-identity";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "vellum-routes-"));
  roots.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const seat = {
  canvasName: "factory",
  nodeId: "agent-1",
  kind: "agent" as const,
  agentKey: "local:worker",
};

describe("route-token store", () => {
  it("mint → resolve works; plaintext not stored", async () => {
    const routesHome = await root();
    const minted = mintRouteToken(seat, routesHome);

    expect(minted.id.length).toBeGreaterThan(0);
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);

    const principal = resolveRouteToken(minted.token, routesHome);
    expect(principal).toEqual({
      kind: "agent",
      canvasName: "factory",
      nodeId: "agent-1",
      agentKey: "local:worker",
    });

    const detailed = resolveRouteTokenDetailed(minted.token, routesHome);
    expect(detailed?.id).toBe(minted.id);
    expect(detailed?.principal).toEqual(principal);

    const record = loadRouteTokenRecord(minted.id, routesHome);
    expect(record).not.toBeNull();
    expect(record!.tokenHash).toBe(hashRouteToken(minted.token));
    expect(JSON.stringify(record)).not.toContain(minted.token);

    // Permissions: dir 0700, file 0600
    expect(lstatSync(routesHome).mode & 0o777).toBe(CONTROL_DIRECTORY_MODE);
    const filePath = join(routesHome, `${minted.id}.json`);
    expect(existsSync(filePath)).toBe(true);
    expect(lstatSync(filePath).mode & 0o777).toBe(CONTROL_FILE_MODE);
    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(minted.token);
  });

  it("revoke → resolve fails", async () => {
    const routesHome = await root();
    const minted = mintRouteToken(seat, routesHome);
    expect(resolveRouteToken(minted.token, routesHome)).not.toBeNull();

    revokeRouteToken(minted.id, routesHome);
    expect(resolveRouteToken(minted.token, routesHome)).toBeNull();
    expect(resolveRouteTokenDetailed(minted.token, routesHome)).toBeNull();

    const record = loadRouteTokenRecord(minted.id, routesHome);
    expect(record?.revokedAt).toBeTypeOf("number");

    // Idempotent revoke
    revokeRouteToken(minted.id, routesHome);
  });

  it("rotate invalidates old token and issues a new one", async () => {
    const routesHome = await root();
    const minted = mintRouteToken(seat, routesHome);
    const rotated = rotateRouteToken(minted.id, routesHome);

    expect(rotated.id).toBe(minted.id);
    expect(rotated.token).not.toBe(minted.token);
    expect(resolveRouteToken(minted.token, routesHome)).toBeNull();
    expect(resolveRouteToken(rotated.token, routesHome)).toEqual({
      kind: "agent",
      canvasName: "factory",
      nodeId: "agent-1",
      agentKey: "local:worker",
    });
  });

  it("rotate / revoke on missing id throw not_found", async () => {
    const routesHome = await root();
    expect(() => rotateRouteToken("missing", routesHome)).toThrow(RouteTokenError);
    expect(() => revokeRouteToken("missing", routesHome)).toThrow(RouteTokenError);
    try {
      rotateRouteToken("missing", routesHome);
    } catch (error) {
      expect(error).toBeInstanceOf(RouteTokenError);
      expect((error as RouteTokenError).code).toBe("not_found");
    }
  });

  it("cannot rotate a revoked token", async () => {
    const routesHome = await root();
    const minted = mintRouteToken(seat, routesHome);
    revokeRouteToken(minted.id, routesHome);
    expect(() => rotateRouteToken(minted.id, routesHome)).toThrow(RouteTokenError);
    try {
      rotateRouteToken(minted.id, routesHome);
    } catch (error) {
      expect((error as RouteTokenError).code).toBe("revoked");
    }
  });

  it("rejects incomplete mint principal", async () => {
    const routesHome = await root();
    expect(() =>
      mintRouteToken(
        { canvasName: "", nodeId: "n1", kind: "agent", agentKey: "a" },
        routesHome,
      ),
    ).toThrow(RouteTokenError);
    expect(() =>
      mintRouteToken(
        { canvasName: "c", nodeId: "n1", kind: "agent" },
        routesHome,
      ),
    ).toThrow(RouteTokenError);
  });

  it("hash helpers are deterministic and timing-safe equal on match", () => {
    const token = generateRouteTokenPlaintext();
    const hash = hashRouteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRouteToken(token)).toBe(hash);
    expect(routeTokenHashEquals(token, hash)).toBe(true);
    expect(routeTokenHashEquals(token + "x", hash)).toBe(false);
    expect(routeTokenHashEquals(token, "zz")).toBe(false);
    expect(routeTokenHashEquals(token, "0".repeat(64))).toBe(false);
  });

  it("unknown token resolves null without throwing", async () => {
    const routesHome = await root();
    mintRouteToken(seat, routesHome);
    expect(resolveRouteToken("0".repeat(64), routesHome)).toBeNull();
    expect(resolveRouteToken("", routesHome)).toBeNull();
  });
});

describe("admitWorkIdentity (pure dual path)", () => {
  const localToken = "a".repeat(64);
  const principal: ProcessPrincipal = {
    kind: "agent",
    agentKey: "local:worker",
    canvasName: "factory",
    nodeId: "agent-1",
  };

  it("Tier 2: local work token + process-bind", () => {
    const result = admitWorkIdentity({
      localToken,
      presentedToken: localToken,
      processIdentity: {
        ok: true,
        peerPid: 4242,
        principal,
      },
      routeResolve: () => null,
    });
    expect(result).toEqual({
      ok: true,
      tier: "process-bind",
      peerPid: 4242,
      principal,
    });
  });

  it("Tier 2: local work token without process-bind fails", () => {
    const result = admitWorkIdentity({
      localToken,
      presentedToken: localToken,
      processIdentity: {
        ok: false,
        denial: "process_unbound",
        message: "not registered",
      },
      routeResolve: () => {
        throw new Error("route should not be consulted when work token matches");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("process_unbound");
      expect(result.denial).toBe("process_unbound");
    }
  });

  it("Tier 3: route-token admits without process-bind", () => {
    const routeToken = "b".repeat(64);
    let processCalled = false;
    const result = admitWorkIdentity({
      localToken,
      presentedToken: routeToken,
      processIdentity: () => {
        processCalled = true;
        return {
          ok: false,
          denial: "process_unbound",
          message: "should not run",
        };
      },
      routeResolve: (token) =>
        token === routeToken
          ? { id: "route-1", principal }
          : null,
    });
    expect(processCalled).toBe(false);
    expect(result).toEqual({
      ok: true,
      tier: "route-token",
      routeId: "route-1",
      principal,
    });
  });

  it("neither token path → auth error", () => {
    const result = admitWorkIdentity({
      localToken,
      presentedToken: "c".repeat(64),
      processIdentity: {
        ok: true,
        peerPid: 1,
        principal,
      },
      routeResolve: () => null,
    });
    expect(result).toEqual({
      ok: false,
      reason: "auth",
      message: "invalid or missing work control token",
    });
  });

  it("workTokenMatches stays timing-safe and exact", () => {
    expect(workTokenMatches(localToken, localToken)).toBe(true);
    expect(workTokenMatches(localToken + "x", localToken)).toBe(false);
    expect(workTokenMatches(undefined, localToken)).toBe(false);
  });
});
