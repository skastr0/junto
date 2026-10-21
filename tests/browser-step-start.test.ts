/**
 * A step a view starts inside `traverse` (Electron's reload does) clears its
 * own pending mark: the page is not busy once the step has started. Found in
 * the browser turn-on run: after the operator's Reload, a seat's box comment
 * was refused "navigation in flight" for the mark's whole timer.
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
import { localBrowserTestMachineName } from "./browser-test-machine";

const PAGE: ResolvedPageTarget = { ref: "junto://canvas/work?node=n1", nodeId: "n1", url: "https://step.example.com/", profile: "personal" };

/** A view whose reload starts, commits and loads inside the traverse call. */
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
  };
  return handle;
};

describe("a step the view starts inside traverse", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  let service: BrowserSessionService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-step-start-"));
    runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    service = new BrowserSessionService(adapter, localBrowserTestMachineName, makeBrowserProfileService(sql, join(root, "browser")));
  });
  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("leaves the page settled, so the next step is not refused as in flight", async () => {
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    expect(service.traverse(opened.data.sessionId, "reload")).toMatchObject({ ok: true });
    // A new document is a new session; it is settled at once.
    const live = service.sessionIdForRef(PAGE.ref)!;
    expect(service.traverse(live, "reload")).toMatchObject({ ok: true });
  });
});
