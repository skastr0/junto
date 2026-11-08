/**
 * Write read cost, a gate: what the window reads after one artifact write
 * must not grow with the board. The same edits run on a board of SMALL and
 * of LARGE Artifacts nodes, every card mounted, with Quick capture closed
 * and then open, and every call the window makes to main is metered at
 * Electron's invoke table: how many, and the JSON bytes they return. If a write re-reads
 * every node (the shape behind 4c919860d, 656ed5ff7, 6006c5ea5 and about a
 * dozen fixes before them), the large board reads LARGE/SMALL times as much,
 * and this fails, however indirect the path from the notice to the read.
 *
 * A board-size-independent cost is the claim, so the bound is a ratio:
 * bytes and calls on the large board stay under GROWTH times the small
 * board's. A fixed cost per write passes at any size.
 *
 *   scripts/run-e2e.sh e2e/scenarios/write-read-cost.spec.ts
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ulid } from "ulid";
import type { ElectronApplication, Page } from "@playwright/test";
import { RESOURCE_IPC_CHANNELS } from "../../src/shared/resource-ipc-channels";
import { makeStateEngineLive } from "../../src/core/state/engine";
import { Node } from "../../src/shared/model";
import { canonicalJson } from "../../src/shared/work-canonical-json";
import { expect, launchJunto, test } from "../harness/launch";
import { mod } from "../harness/keys";
import { modelFixture } from "../harness/model";
import type { Sandbox } from "../harness/sandbox";

const CANVAS = "write-cost";
const SMALL = 4;
const LARGE = 16;
const DOCS_PER_NODE = 6;
const DOC_CHARS = 2_000;
const WRITES = 3;
/** Large over small, for bytes and calls. A per-node re-read gives LARGE / SMALL = 4. */
const GROWTH = 1.5;

/** The channel an artifact write goes on: counted to prove the meter is on the path, never as a read. */
const WRITE_CHANNEL = RESOURCE_IPC_CHANNELS.artifact.apply;

const decode = (value: unknown) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(value);
const nodeIds = (count: number): ReadonlyArray<string> => Array.from({ length: count }, (_, i) => `shelf-${i}`);

/** Every Artifacts node on screen at once, so every card's read is live: 4 columns of 280 by 160. */
const boardOf = (count: number) =>
  modelFixture(
    nodeIds(count).map((id, i) =>
      decode({ kind: "artifacts", id, label: `Shelf ${i + 1}`, x: 40 + (i % 4) * 300, y: 40 + Math.floor(i / 4) * 180, width: 280, height: 160, z: 0 }),
    ),
  );

type Doc = { readonly id: string; readonly node: string; readonly bodyJson: string; readonly refJson: string; readonly at: number };

const docsOf = (count: number): ReadonlyArray<Doc> =>
  nodeIds(count).flatMap((node, n) =>
    Array.from({ length: DOCS_PER_NODE }, (_, d) => {
      const markdown = `# Doc ${n}-${d}\n\n${"the quick brown fox ships the build. ".repeat(Math.ceil(DOC_CHARS / 37))}`.slice(0, DOC_CHARS);
      const bodyJson = canonicalJson({ type: "document", markdown });
      const bytes = Buffer.from(bodyJson, "utf8");
      return {
        id: ulid(),
        node,
        bodyJson,
        refJson: JSON.stringify({ sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType: "application/json" }),
        at: 1_760_000_000_000 - (n * DOCS_PER_NODE + d) * 1_000,
      };
    }),
  );

const seedDocs = (docs: ReadonlyArray<Doc>) => async (sandbox: Sandbox): Promise<void> => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const doc of docs) {
            yield* sql`INSERT INTO artifact_heads(
                canvas_name, artifact_id, node_id, type, title, version, created_by_json, updated_at, archived, task_ids_json)
              VALUES (${CANVAS}, ${doc.id}, ${doc.node}, 'document', ${`Doc ${doc.id.slice(-4)}`}, 1, ${'{"kind":"operator"}'}, ${doc.at}, 0, '[]')`;
            yield* sql`INSERT INTO artifact_versions(
                canvas_name, artifact_id, version, op_id, author_json, at, edit_json, body_ref_json, inline_body_json)
              VALUES (${CANVAS}, ${doc.id}, 1, ${ulid()}, ${'{"kind":"operator"}'}, ${doc.at}, NULL, ${doc.refJson}, ${doc.bodyJson})`;
          }
        }),
      ),
    );
  } finally {
    await runtime.dispose();
  }
};

type Meter = {
  readonly calls: number;
  readonly bytes: number;
  /** The writes the meter saw: it must see every one, or it is not on the path the window calls. */
  readonly writes: number;
  readonly by: Readonly<Record<string, { calls: number; bytes: number }>>;
};

/**
 * Meter every call the window makes to main: wrap each handler in
 * `ipcMain._invokeHandlers`, Electron's own table of `ipcMain.handle`
 * channels, to count its calls and the JSON bytes it resolves to. The window's
 * API objects cross contextBridge frozen, so the meter sits where every
 * invoke lands instead. Installed once per launch, after boot.
 */
const installMeter = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ ipcMain }) => {
    type Tally = { calls: number; bytes: number };
    const g = globalThis as unknown as { __readMeter: Record<string, Tally> };
    g.__readMeter = {};
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    if (handlers === undefined) throw new Error("ipcMain._invokeHandlers is gone: this Electron keeps its invoke table elsewhere");
    const sizeOf = (value: unknown): number => {
      try {
        return JSON.stringify(value)?.length ?? 0;
      } catch {
        return 0;
      }
    };
    const tally = (channel: string, value: unknown): void => {
      const entry = (g.__readMeter[channel] ??= { calls: 0, bytes: 0 });
      entry.calls += 1;
      entry.bytes += sizeOf(value);
    };
    for (const [channel, handler] of handlers) {
      handlers.set(channel, async (...args: unknown[]) => {
        const out = await handler(...args);
        tally(channel, out);
        return out;
      });
    }
    return handlers.size;
  });

const resetMeter = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => void ((globalThis as unknown as { __readMeter: object }).__readMeter = {}));

/** The meter since the last reset; writes are counted apart and their bytes left out. */
const readMeter = (app: ElectronApplication, writeChannel: string): Promise<Meter> =>
  app.evaluate((_electron, write) => {
    const raw = (globalThis as unknown as { __readMeter: Record<string, { calls: number; bytes: number }> }).__readMeter;
    const by = Object.fromEntries(Object.entries(raw).filter(([channel]) => channel !== write));
    const values = Object.values(by);
    return {
      calls: values.reduce((sum, v) => sum + v.calls, 0),
      bytes: values.reduce((sum, v) => sum + v.bytes, 0),
      writes: raw[write]?.calls ?? 0,
      by,
    };
  }, writeChannel);

/** WRITES edits to documents on the first node, each given a beat to draw what it causes. */
const edit = async (page: Page, docs: ReadonlyArray<Doc>, versions: Map<string, number>): Promise<void> => {
  const targets = docs.filter((doc) => doc.node === "shelf-0").slice(0, WRITES);
  for (const doc of targets) {
    const base = versions.get(doc.id) ?? 1;
    const kind = await page.evaluate(
      async ({ canvas, node, id, base, opId }) => {
        const api = (window as unknown as { junto: { resource: { artifact: { apply: (...a: unknown[]) => Promise<{ kind: string }> } } } }).junto.resource;
        const out = await api.artifact.apply(canvas, node, id, opId, {
          op: "edit",
          edit: { kind: "replace", baseVersion: base, body: { type: "document", markdown: `# edited ${opId}\n\nshort body` } },
        });
        return out.kind;
      },
      { canvas: CANVAS, node: doc.node, id: doc.id, base, opId: ulid() },
    );
    expect(["applied", "queued"], `edit of ${doc.id}`).toContain(kind);
    versions.set(doc.id, base + 1);
    await page.waitForTimeout(700);
  }
};

type Run = { readonly closed: Meter; readonly capture: Meter };

const measure = async (count: number): Promise<Run> => {
  const docs = docsOf(count);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 1000 },
    seedModels: { [CANVAS]: boardOf(count) },
    afterSeed: seedDocs(docs),
  });
  try {
    const { app, page } = junto;
    for (const id of nodeIds(count)) await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible({ timeout: 60_000 });
    expect(await installMeter(app), "invoke channels metered").toBeGreaterThan(10);
    await page.waitForTimeout(2_000);
    const versions = new Map<string, number>();

    await resetMeter(app);
    await edit(page, docs, versions);
    const closed = await readMeter(app, WRITE_CHANNEL);

    await page.keyboard.press(mod("t"));
    await expect(page.getByRole("dialog", { name: "Quick capture" })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_500);
    await resetMeter(app);
    await edit(page, docs, versions);
    const capture = await readMeter(app, WRITE_CHANNEL);
    return { closed, capture };
  } finally {
    await junto.close();
  }
};

/** The paths that grew most from the small board to the large, for the failure message. */
const growth = (small: Meter, large: Meter): string =>
  Object.entries(large.by)
    .map(([path, v]) => ({ path, bytes: v.bytes, calls: v.calls, was: small.by[path] ?? { calls: 0, bytes: 0 } }))
    .sort((a, b) => b.bytes - b.was.bytes - (a.bytes - a.was.bytes))
    .slice(0, 5)
    .map((p) => `${p.path}: ${p.was.calls} calls ${p.was.bytes} B -> ${p.calls} calls ${p.bytes} B`)
    .join("; ");

test("one artifact write reads the same on a board of 16 Artifacts nodes as on 4", async () => {
  test.setTimeout(600_000);
  const small = await measure(SMALL);
  const large = await measure(LARGE);
  for (const phase of ["closed", "capture"] as const) {
    const s = small[phase];
    const l = large[phase];
    console.log(`WRITE-READ-COST ${phase} ${JSON.stringify({ small: s, large: l })}`);
    const why = `Quick capture ${phase === "closed" ? "closed" : "open"}, ${WRITES} writes, ${SMALL} vs ${LARGE} nodes; grew most: ${growth(s, l)}`;
    expect([s.writes, l.writes], `the meter must see every write it is to cost (${why})`).toEqual([WRITES, WRITES]);
    expect(s.calls, `the small board read nothing after ${WRITES} writes: the meter saw no reads (${why})`).toBeGreaterThan(0);
    expect(l.bytes, `bytes read grow with the board (${why})`).toBeLessThanOrEqual(Math.max(s.bytes, 1) * GROWTH);
    expect(l.calls, `reads grow with the board (${why})`).toBeLessThanOrEqual(Math.max(s.calls, 1) * GROWTH);
  }
});
