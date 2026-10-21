/**
 * POST /comment (B7): a seat's box comment rides its screenshot grant. The
 * route hands on the lease's own owner, seat and page; a grant that names
 * no seat is refused before any shot is taken.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchControlRequest, makeControlHandlers, type PostPageBoxComment } from "../src/main/junto/browser/control";
import { BROWSER_CAPABILITY_ACTIONS, makeBrowserCapabilityRegistry, type BrowserCapabilityRegistry } from "../src/main/junto/browser/capabilities";
import type { ResolvedPageTarget } from "../src/main/junto/browser/page-target";
import { makeBrowserProfileService } from "../src/main/junto/browser/profiles";
import { BrowserSessionService, type BrowserViewAdapter, type BrowserViewHandle } from "../src/main/junto/browser/sessions";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { localBrowserTestMachineName } from "./browser-test-machine";
import { canvasOf, page as pageNode } from "./support/model-nodes";
import { memoryTouchedOriginStore } from "./support/touched-origin-store";

const REF = "junto://canvas/work?node=n1";
const TARGET: ResolvedPageTarget = { ref: REF, nodeId: "n1", url: "https://example.com/", profile: "personal" };
const TOKEN = "test-token";

const adapter: BrowserViewAdapter = (_partition, events) => {
  let resolveDestroyed!: () => void;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const handle: BrowserViewHandle = {
    loadUrl: async (url, expectedSessionId) => {
      const sessionId = events.onNavigationStart({ url: new URL(url).href, isSameDocument: false, expectedSessionId });
      if (sessionId !== undefined) {
        events.onNavigationUrl(sessionId, new URL(url).href);
        events.onLoadOk(sessionId, "loaded");
      }
    },
    attach: () => {},
    setBounds: () => {},
    detach: () => {},
    destroy: () => resolveDestroyed(),
    whenDestroyed: () => destroyed,
  };
  return handle;
};

describe("POST /comment", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  const registries: BrowserCapabilityRegistry[] = [];
  let counter = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-control-comment-"));
    runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
  });
  afterEach(async () => {
    for (const registry of registries.splice(0)) registry.close();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const stack = async (options: { readonly actorNodeId?: string; readonly post?: PostPageBoxComment }) => {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    const sessions = new BrowserSessionService(adapter, localBrowserTestMachineName, makeBrowserProfileService(sql, join(root, "browser")));
    sessions.setTouchedOriginStore(memoryTouchedOriginStore());
    const capabilities = makeBrowserCapabilityRegistry({ onTerminate: (notice) => sessions.destroyOwnerSessions(notice.auditId, "ended") });
    registries.push(capabilities);
    const principal = capabilities.createPrincipal();
    const grant = capabilities.issue(principal, {
      actions: BROWSER_CAPABILITY_ACTIONS,
      targets: [{ ref: REF, profile: TARGET.profile, exactOrigins: [new URL(TARGET.url).origin] }],
      ttlMs: 60_000,
      maxUses: 100,
      maxInFlight: 8,
      ...(options.actorNodeId === undefined ? {} : { actorNodeId: options.actorNodeId }),
    });
    const handlers = makeControlHandlers({
      sessions,
      capabilities,
      resolvePageTarget: async () => ({ ok: true, data: TARGET }),
      version: "0.0.0-test",
      listDocuments: async () => [{ name: "work", doc: canvasOf([pageNode("n1", { url: TARGET.url, profile: TARGET.profile })], [], "work") }],
      shotsDir: join(root, "shots"),
      ...(options.post === undefined ? {} : { postPageBoxComment: options.post }),
    });
    const call = (path: string, body: unknown) =>
      dispatchControlRequest(
        handlers,
        TOKEN,
        { method: "POST", path, token: TOKEN, requestId: (++counter).toString(16).padStart(32, "0"), body },
        undefined,
        { kind: "lease", secret: grant.secret, expectedPrincipal: principal },
      );
    const opened = await call("/open", { ref: REF });
    if (!opened.envelope.ok) throw new Error("open failed");
    return { call, sessionId: (opened.envelope.data as { sessionId: string }).sessionId, grant };
  };

  const RECT = { x: 1, y: 2, w: 30, h: 40 };

  it("hands on the lease's owner, seat and page, and answers the comment", async () => {
    const posts: Array<Parameters<PostPageBoxComment>[0]> = [];
    const { call, sessionId, grant } = await stack({
      actorNodeId: "seat-a",
      post: async (input) => {
        posts.push(input);
        return { ok: true, data: { messageId: "m1", threadId: "m1" } };
      },
    });
    expect(await call("/comment", { sessionId, rect: RECT, text: "cut off" })).toMatchObject({
      status: 200,
      envelope: { ok: true, data: { messageId: "m1", threadId: "m1" } },
    });
    expect(posts).toMatchObject([{ owner: grant.auditId, sessionId, seatNodeId: "seat-a", pageRef: REF, rect: RECT, text: "cut off" }]);
  });

  it("refuses a grant that names no seat, a build with no writer, and bodies that are not a box", async () => {
    const posts: unknown[] = [];
    const post: PostPageBoxComment = async (input) => {
      posts.push(input);
      return { ok: true, data: { messageId: "m1", threadId: "m1" } };
    };
    const anonymous = await stack({ post });
    expect(await anonymous.call("/comment", { sessionId: anonymous.sessionId, rect: RECT, text: "x" })).toMatchObject({
      envelope: { ok: false, error: { _tag: "forbidden" } },
    });
    const unwired = await stack({ actorNodeId: "seat-a" });
    expect(await unwired.call("/comment", { sessionId: unwired.sessionId, rect: RECT, text: "x" })).toMatchObject({
      envelope: { ok: false, error: { _tag: "unsupported_capability" } },
    });
    const seat = await stack({ actorNodeId: "seat-a", post });
    for (const body of [
      { sessionId: seat.sessionId, rect: RECT, text: "x", png: "AAAA" },
      { sessionId: seat.sessionId, rect: { ...RECT, w: Number.POSITIVE_INFINITY }, text: "x" },
      { sessionId: seat.sessionId, rect: { ...RECT, shot: "x" }, text: "x" },
      { sessionId: seat.sessionId, rect: RECT, text: "  " },
    ]) {
      expect((await seat.call("/comment", body)).envelope, JSON.stringify(body)).toMatchObject({ ok: false, error: { _tag: "bad_request" } });
    }
    expect(posts).toEqual([]);
  });
});
