/**
 * The takeover notice (signal 01M5EY4765B700PENESKE0YC1X: accept and show a
 * notice). Taking over a tab whose document a seat ran code in puts one line
 * in the chrome's state; a reload or a cross-document navigation clears it,
 * and a same-document one does not.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBrowserProfileService } from "../src/main/junto/browser/profiles";
import { BrowserSessionService, type BrowserViewAdapter, type BrowserViewHandle } from "../src/main/junto/browser/sessions";
import type { ResolvedPageTarget } from "../src/main/junto/browser/page-target";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { SEAT_CODE_NOTICE } from "../src/shared/browser-chrome";
import { localBrowserTestMachineName } from "./browser-test-machine";
import { memoryTouchedOriginStore } from "./support/touched-origin-store";

const PAGE: ResolvedPageTarget = { ref: "junto://canvas/work?node=n1", nodeId: "n1", url: "https://seat.example.com/", profile: "personal" };

/** A view that loads at once; a reload is a new document, a hash step is not. */
const adapter: BrowserViewAdapter = (_partition, events) => {
  let resolveDestroyed!: () => void;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  let current = "about:blank";
  const commit = (url: string, expectedSessionId?: string) => {
    const sessionId = events.onNavigationStart({ url, isSameDocument: false, expectedSessionId });
    if (sessionId === undefined) return;
    current = url;
    events.onNavigationUrl(sessionId, url);
    events.onDocumentCommitted(url);
    events.onLoadOk(sessionId, "loaded");
  };
  const handle: BrowserViewHandle = {
    loadUrl: async (url, expectedSessionId) => commit(new URL(url).href, expectedSessionId),
    traverse: (step) => {
      if (step === "reload") commit(current);
    },
    history: () => ({ canGoBack: false, canGoForward: false }),
    attach: () => {},
    setBounds: () => {},
    detach: () => {},
    destroy: () => resolveDestroyed(),
    whenDestroyed: () => destroyed,
    executeJavaScript: async () => ({ __juntoEval: 1, status: "ok", json: "1" }),
  };
  return handle;
};

describe("the takeover notice", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  let service: BrowserSessionService;
  let sessionId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-seat-code-"));
    runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    service = new BrowserSessionService(adapter, localBrowserTestMachineName, makeBrowserProfileService(sql, join(root, "browser")));
    service.setTouchedOriginStore(memoryTouchedOriginStore());
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    sessionId = opened.data.sessionId;
    expect(await service.openForOwner("job-a", PAGE)).toMatchObject({ ok: true });
  });
  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const seatRuns = async () => expect(await service.evalForOwner("job-a", sessionId, "1")).toMatchObject({ ok: true });
  /** The page's live session: a new document is a new session. */
  const live = () => service.sessionIdForRef(PAGE.ref)!;
  const state = () => {
    const page = service.pageState(live());
    if (page === undefined) throw new Error("the page is not open");
    return page;
  };
  const notice = () => state().seatCode;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("shows on a takeover after a seat ran code in the document, and a reload clears it", async () => {
    await seatRuns();
    // Shared, the operator is not typing into a page they hold: nothing yet.
    expect(notice()).toBeUndefined();
    expect(service.takeOver(sessionId)).toMatchObject({ ok: true });
    const active = state().tabs.active;
    expect(notice()).toMatchObject({ tabs: [active], message: SEAT_CODE_NOTICE });
    expect(service.traverse(sessionId, "reload")).toMatchObject({ ok: true });
    await settle();
    expect(notice()).toBeUndefined();
    // The new document holds no seat code: a later takeover says nothing.
    expect(service.release(live())).toMatchObject({ ok: true });
    expect(service.takeOver(live())).toMatchObject({ ok: true });
    expect(notice()).toBeUndefined();
  });

  it("clears on a cross-document navigation", async () => {
    await seatRuns();
    service.takeOver(sessionId);
    expect(notice()).toBeDefined();
    expect(await service.goto(sessionId, "https://seat.example.com/next")).toMatchObject({ ok: true });
    expect(notice()).toBeUndefined();
  });

  it("says nothing on a takeover when no seat ran code", () => {
    expect(service.takeOver(sessionId)).toMatchObject({ ok: true });
    expect(notice()).toBeUndefined();
  });
});
