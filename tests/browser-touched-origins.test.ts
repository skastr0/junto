import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { clearTouchedServiceWorkersAtStart } from "../src/main/junto/browser/composition";
import { makeBrowserProfileService } from "../src/main/junto/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
  type BrowserViewHandle,
} from "../src/main/junto/browser/sessions";
import type { ResolvedPageTarget } from "../src/main/junto/browser/page-target";
import {
  makeBrowserTouchedOriginStore,
  type BrowserTouchedOriginStore,
} from "../src/main/junto/browser/touched-origins";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { inProcessCore } from "../src/main/core-process/client";
import { coreTouchedOriginStore } from "../src/main/core-process/ops/browser";
import { partitionNameForProfile } from "../src/shared/browser";
import { localBrowserTestMachineName } from "./browser-test-machine";

const PAGE: ResolvedPageTarget = {
  ref: "junto://canvas/work?node=n1",
  nodeId: "n1",
  url: "https://touched.example.com/",
  profile: "personal",
};

/** A view that loads at once and answers every eval; it records what it ran. */
const makeAdapter = (evals: string[]): BrowserViewAdapter => (_partition, events) => {
  let resolveDestroyed!: () => void;
  const destroyed = new Promise<void>((resolve) => {
    resolveDestroyed = resolve;
  });
  const handle: BrowserViewHandle = {
    loadUrl: async (url, expectedSessionId) => {
      const sessionId = events.onNavigationStart({ url: new URL(url).href, isSameDocument: false, expectedSessionId });
      if (sessionId !== undefined) {
        events.onNavigationUrl(sessionId, new URL(url).href);
        events.onDocumentCommitted(new URL(url).href);
        events.onLoadOk(sessionId, "loaded");
      }
    },
    attach: () => {},
    setBounds: () => {},
    detach: () => {},
    destroy: () => resolveDestroyed(),
    whenDestroyed: () => destroyed,
    executeJavaScript: async (code) => {
      evals.push(code);
      return { __juntoEval: 1, status: "ok", json: "1" };
    },
  };
  return handle;
};

describe("write-ahead touched origins", () => {
  let root: string;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  let sql: SqlClient.SqlClient;

  const startState = async (): Promise<void> => {
    runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
    sql = await runtime.runPromise(SqlClient.SqlClient);
  };

  const serviceWith = (store: BrowserTouchedOriginStore, evals: string[]) => {
    const service = new BrowserSessionService(
      makeAdapter(evals),
      localBrowserTestMachineName,
      makeBrowserProfileService(sql, join(root, "browser")),
    );
    service.setTouchedOriginStore(store);
    return service;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "junto-touched-"));
    await startState();
  });
  afterEach(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("clears a seat's eval origin at the next start after a kill, and keeps an untouched one", async () => {
    const evals: string[] = [];
    const service = serviceWith(makeBrowserTouchedOriginStore(sql), evals);
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    expect(await service.openForOwner("job-a", PAGE)).toMatchObject({ ok: true });
    expect(await service.evalForOwner("job-a", opened.data.sessionId, "1")).toMatchObject({ ok: true });
    // The operator's own eval in another origin records nothing.
    await service.goto(opened.data.sessionId, "https://untouched.example.org/");

    // Killed: no shutdown, no teardown. The next run opens the same database.
    await runtime.dispose();
    await startState();
    const store = makeBrowserTouchedOriginStore(sql);
    const cleared: string[] = [];
    await clearTouchedServiceWorkersAtStart(store, async (partition, origin) => {
      cleared.push(`${partition} ${origin}`);
    });
    expect(cleared).toEqual([`${partitionNameForProfile("personal")} https://touched.example.com`]);
    expect(await store.list()).toEqual([]);
  });

  it("keeps the same rows when main asks the core for them by name", async () => {
    const store = coreTouchedOriginStore(inProcessCore(runtime));
    await store.record({ profile: "personal", origin: "https://a.example.com" });
    await store.record({ profile: "personal", origin: "https://a.example.com" });
    await store.record({ profile: "work", origin: "https://b.example.com" });
    expect(await makeBrowserTouchedOriginStore(sql).list()).toEqual([
      { profile: "personal", origin: "https://a.example.com" },
      { profile: "work", origin: "https://b.example.com" },
    ]);
    await store.remove([{ profile: "personal", origin: "https://a.example.com" }]);
    await store.removeProfile("work");
    expect(await store.list()).toEqual([]);
  });

  it("refuses a seat's eval whose origin cannot be recorded, and never runs it", async () => {
    const evals: string[] = [];
    const failing: BrowserTouchedOriginStore = {
      ...makeBrowserTouchedOriginStore(sql),
      record: async () => {
        throw new Error("disk full");
      },
    };
    const service = serviceWith(failing, evals);
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    expect(await service.openForOwner("job-a", PAGE)).toMatchObject({ ok: true });
    expect(await service.evalForOwner("job-a", opened.data.sessionId, "1")).toMatchObject({
      ok: false,
      code: "failed",
      message: "eval refused: its origin could not be recorded",
    });
    expect(evals).toEqual([]);
    // The operator's own eval writes nothing and runs.
    expect(await service.evalForOwner("junto-ui", opened.data.sessionId, "2")).toMatchObject({ ok: true });
    expect(evals).toEqual(["2"]);
  });

  it("stays on this machine: only the browser's own schema and store name the table", () => {
    // Every exchange, copy and link selector names what it reads, so a
    // selector that never names the table never carries it.
    const src = join(import.meta.dirname, "..", "src");
    const naming = (readdirSync(src, { recursive: true }) as string[])
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .filter((path) => readFileSync(join(src, path), "utf8").includes("browser_touched_origins"))
      .sort();
    expect(naming).toEqual([
      "main/junto/browser/state-schema.ts",
      "main/junto/browser/touched-origins.ts",
      // The step that creates it, on this machine's database.
      "main/junto/state/migrations.ts",
    ]);
  });

  it("refuses a seat's eval when no record is bound", async () => {
    const evals: string[] = [];
    const service = new BrowserSessionService(
      makeAdapter(evals),
      localBrowserTestMachineName,
      makeBrowserProfileService(sql, join(root, "browser")),
    );
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    await service.openForOwner("job-a", PAGE);
    expect(await service.evalForOwner("job-a", opened.data.sessionId, "1")).toMatchObject({
      ok: false,
      message: "eval refused: no record of touched origins is bound",
    });
    expect(evals).toEqual([]);
  });

  it("says on the page and in the log when the record is full, and refuses the seat's eval", async () => {
    await runtime.runPromise(
      SqlClient.SqlClient.use((client) => client`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4096)
        INSERT INTO browser_touched_origins (profile, origin)
        SELECT 'personal', 'https://filler-' || i || '.example.com' FROM n
      `),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const evals: string[] = [];
    const service = serviceWith(makeBrowserTouchedOriginStore(sql), evals);
    const opened = await service.open(PAGE);
    if (!opened.ok) throw new Error("open failed");
    await service.openForOwner("job-a", PAGE);
    expect(await service.evalForOwner("job-a", opened.data.sessionId, "1")).toMatchObject({
      ok: false,
      code: "failed",
      message: "eval refused: Seat code is refused: the record of sites seats touched is full until Junto restarts",
    });
    expect(evals).toEqual([]);
    expect(service.pageState(opened.data.sessionId)?.blocked?.message).toMatch(/record of sites seats touched is full/);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("is full"));
    errors.mockRestore();
  });

  it("keeps rows within the schema: http(s) origins, a bounded count", async () => {
    const store = makeBrowserTouchedOriginStore(sql);
    await store.record({ profile: "personal", origin: "https://a.example.com" });
    await store.record({ profile: "personal", origin: "https://a.example.com" });
    await expect(store.record({ profile: "personal", origin: "file://" })).rejects.toBeDefined();
    await store.record({ profile: "work", origin: "http://b.example.com" });
    await store.removeProfile("work");
    expect(await store.list()).toEqual([{ profile: "personal", origin: "https://a.example.com" }]);
  });
});
