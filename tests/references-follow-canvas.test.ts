/**
 * Region reference rows follow the canvas: a removed region takes its rows,
 * a removed canvas takes all of its region rows, a renamed canvas re-keys
 * them. Driven by a fake event source over a real store in a temp folder.
 * Nothing is ever deleted except on an event, and app-wide rows and the
 * briefing are never touched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { onReferencesChanged } from "../src/main/junto/references/changes";
import { followCanvas, type CanvasEventSource } from "../src/main/junto/references/follow-canvas";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { asCanvasName, asNodeId } from "../src/shared/model/base";
import type { CanvasesChanged, Changed } from "../src/shared/model";
import { APP_REFERENCE_PLACE, type ReferencePlace, type ReferencesChangedEvent } from "../src/shared/references";

const makeSource = () => {
  const changes = new Set<(event: Changed) => void>();
  const canvases = new Set<(event: CanvasesChanged) => void>();
  const source: CanvasEventSource = {
    subscribeChanges: (listener) => {
      changes.add(listener);
      return () => void changes.delete(listener);
    },
    subscribeCanvasesChanges: (listener) => {
      canvases.add(listener);
      return () => void canvases.delete(listener);
    },
  };
  return {
    source,
    listeners: () => changes.size + canvases.size,
    removed: (canvas: string, ...nodes: string[]) => {
      const event: Changed = {
        canvas: asCanvasName(canvas), seq: 1, nodes: [], wires: [], removedNodes: nodes.map(asNodeId), removedWires: [],
      };
      for (const listener of changes) listener(event);
    },
    canvases: (event: { _tag: "Created" | "Removed"; canvas: string } | { _tag: "Renamed"; from: string; to: string }) => {
      const typed = (event._tag === "Renamed"
        ? { _tag: "Renamed", from: asCanvasName(event.from), to: asCanvasName(event.to) }
        : { _tag: event._tag, canvas: asCanvasName(event.canvas) }) as CanvasesChanged;
      for (const listener of canvases) listener(typed);
    },
  };
};

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>;
let fake: ReturnType<typeof makeSource>;
let events: ReferencesChangedEvent[];
let stopListening: () => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-references-follow-"));
  fake = makeSource();
  const store = ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db"))));
  runtime = ManagedRuntime.make(Layer.provideMerge(Layer.effectDiscard(followCanvas(fake.source)), store));
  await runtime.runPromise(Effect.void);
  events = [];
  stopListening = onReferencesChanged((event) => events.push(event));
});

afterEach(async () => {
  stopListening();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const region = (regionId: string, canvasName = "factory"): ReferencePlace => ({ kind: "region", canvasName, regionId });
const store = <A, E>(use: (repository: ReferencesRepository["Service"]) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(ReferencesRepository, use));

const rows = (): string[] => {
  const database = new DatabaseSync(join(root, "junto.db"), { readOnly: true });
  try {
    return (database
      .prepare("SELECT scope_kind, canvas_name, region_id, name, body FROM app_texts ORDER BY scope_kind, canvas_name, region_id, name")
      .all() as ReadonlyArray<Record<string, string>>)
      .map((row) => [row.scope_kind, row.canvas_name, row.region_id, row.name, row.body].join("|"));
  } finally {
    database.close();
  }
};

/** The follower works on its own fiber: wait until the rows are what is expected. */
const settled = async (expected: ReadonlyArray<string>) => {
  for (let attempt = 0; attempt < 200 && JSON.stringify(rows()) !== JSON.stringify(expected); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(rows()).toEqual(expected);
};

const APP = ["app|||style|App style.", "briefing||||House rules."];
const seed = async () => {
  await store((r) => r.briefingWrite("House rules.", "operator"));
  await store((r) => r.write(APP_REFERENCE_PLACE, { name: "style", body: "App style." }, "operator"));
  await store((r) => r.write(region("region-a"), { name: "style", body: "A style." }, "operator"));
  await store((r) => r.write(region("region-a"), { name: "runbook", body: "A runbook." }, "operator"));
  await store((r) => r.write(region("region-b"), { name: "style", body: "B style." }, "operator"));
  await store((r) => r.write(region("region-a", "other"), { name: "style", body: "Other A." }, "operator"));
  events.length = 0;
};
const FACTORY_A = ["region|factory|region-a|runbook|A runbook.", "region|factory|region-a|style|A style."];
const FACTORY_B = ["region|factory|region-b|style|B style."];
const OTHER = ["region|other|region-a|style|Other A."];

describe("region references follow the canvas", () => {
  it("deletes a removed region's rows and nothing else, and tells open pages what went", async () => {
    await seed();
    // A seat and a region go in one change; the seat has no rows and costs nothing.
    fake.removed("factory", "agent-1", "region-a");
    await settled([...APP, ...FACTORY_B, ...OTHER]);
    expect(events).toEqual([
      { kind: "reference", name: "runbook", canvasName: "factory", regionId: "region-a" },
      { kind: "reference", name: "style", canvasName: "factory", regionId: "region-a" },
    ]);
    // The same event again, and one for a region that never had rows, change nothing and announce nothing.
    fake.removed("factory", "agent-1", "region-a");
    fake.removed("factory", "region-never");
    fake.canvases({ _tag: "Created", canvas: "brand-new" });
    fake.removed("factory", "region-b");
    await settled([...APP, ...OTHER]);
    expect(events).toHaveLength(3);
  });

  it("leaves every row alone on a change that removes nothing", async () => {
    await seed();
    fake.removed("factory");
    fake.canvases({ _tag: "Created", canvas: "factory" });
    fake.removed("other", "region-a");
    await settled([...APP, ...FACTORY_A, ...FACTORY_B]);
    expect(events).toEqual([{ kind: "reference", name: "style", canvasName: "other", regionId: "region-a" }]);
  });

  it("deletes every region row of a removed canvas, and only of that canvas", async () => {
    await seed();
    fake.canvases({ _tag: "Removed", canvas: "factory" });
    await settled([...APP, ...OTHER]);
    expect(events.map((event) => (event.kind === "reference" ? [event.canvasName, event.regionId, event.name] : event))).toEqual([
      ["factory", "region-a", "runbook"],
      ["factory", "region-a", "style"],
      ["factory", "region-b", "style"],
    ]);
    fake.canvases({ _tag: "Removed", canvas: "factory" });
    fake.canvases({ _tag: "Removed", canvas: "never-was" });
    fake.canvases({ _tag: "Removed", canvas: "" });
    fake.removed("other", "region-a");
    await settled([...APP]);
    expect(events).toHaveLength(4);
  });

  it("re-keys a renamed canvas's region rows to the new name, all at once", async () => {
    await seed();
    fake.canvases({ _tag: "Renamed", from: "factory", to: "plant" });
    const moved = [...FACTORY_A, ...FACTORY_B].map((row) => row.replace("region|factory|", "region|plant|"));
    await settled([...APP, ...OTHER, ...moved]);
    expect(await store((r) => r.list(region("region-a", "plant")))).toHaveLength(2);
    expect(await store((r) => r.list(region("region-a")))).toEqual([]);
    // Both names are announced, so a page on either one refreshes.
    expect(events.map((event) => (event.kind === "reference" ? event.canvasName : event))).toEqual([
      "factory", "factory", "factory", "plant", "plant", "plant",
    ]);
    // Repeated, it finds nothing under the old name.
    fake.canvases({ _tag: "Renamed", from: "factory", to: "plant" });
    fake.canvases({ _tag: "Removed", canvas: "other" });
    await settled([...APP, ...moved]);
    expect(events).toHaveLength(7);
  });

  it("lets the renamed canvas's row win a key an older canvas left under the new name", async () => {
    await seed();
    // "other" once had a canvas whose rows were never cleared; "factory" now takes that name.
    await store((r) => r.write(region("region-b", "other"), { name: "keep", body: "Older, different key." }, "operator"));
    await store((r) => r.write(region("region-a"), { name: "only-here", body: "Moves." }, "operator"));
    await store((r) => r.write(region("region-a", "other"), { name: "runbook", body: "Older runbook." }, "operator"));
    fake.canvases({ _tag: "Renamed", from: "factory", to: "other" });
    await settled([
      ...APP,
      "region|other|region-a|only-here|Moves.",
      "region|other|region-a|runbook|A runbook.",
      "region|other|region-a|style|A style.",
      "region|other|region-b|keep|Older, different key.",
      "region|other|region-b|style|B style.",
    ]);
  });

  it("applies events in the order they were published", async () => {
    await seed();
    fake.canvases({ _tag: "Renamed", from: "factory", to: "plant" });
    fake.removed("plant", "region-a");
    fake.canvases({ _tag: "Renamed", from: "plant", to: "works" });
    await settled([...APP, ...OTHER, "region|works|region-b|style|B style."]);
  });

  it("stops listening when its scope closes, and never deletes without an event", async () => {
    await seed();
    expect(fake.listeners()).toBe(2);
    // Rows for regions no canvas has are left as they are: there is no sweep.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rows()).toEqual([...APP, ...FACTORY_A, ...FACTORY_B, ...OTHER]);
    const before = rows();
    await runtime.dispose();
    expect(fake.listeners()).toBe(0);
    fake.canvases({ _tag: "Removed", canvas: "factory" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rows()).toEqual(before);
    runtime = ManagedRuntime.make(ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  });
});
