/**
 * The app briefing and references store, over a real state database in a
 * temp folder: what is kept, what is refused, and that the app, each region
 * and the briefing never see each other's rows.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import {
  APP_REFERENCE_PLACE,
  normalizeReferenceName,
  referencesInScope,
  toReferenceListEntry,
  toReferenceListing,
  type ReferencePlace,
} from "../src/shared/references";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-references-"));
  runtime = ManagedRuntime.make(
    ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, ReferencesRepository>) => runtime.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E, ReferencesRepository>) => runtime.runPromise(Effect.flip(effect));
const region = (regionId: string, canvasName = "factory"): ReferencePlace => ({ kind: "region", canvasName, regionId });

describe("a reference name", () => {
  it("is lower-cased and held to what types as one argument", () => {
    expect(normalizeReferenceName("  Release.Notes_v2-a ")).toEqual({ ok: true, name: "release.notes_v2-a" });
    expect(normalizeReferenceName("a".repeat(80))).toMatchObject({ ok: true });
    for (const bad of ["", "   ", "a".repeat(81), "-lead", ".hidden", "two words", "a/b", "é", 7, null]) {
      expect(normalizeReferenceName(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("ReferencesRepository", () => {
  it("keeps one briefing of any length, replaces it, and clears it when nothing is left", async () => {
    const long = `# House rules\r\n${"line\n".repeat(60_000)}`;
    const result = await run(
      Effect.gen(function* () {
        const r = yield* ReferencesRepository;
        const empty = yield* r.briefingRead();
        const first = yield* r.briefingWrite(long, "operator");
        const second = yield* r.briefingWrite("Short now.", "overseer:agent-1");
        const read = yield* r.briefingRead();
        const cleared = yield* r.briefingWrite("  \n ", "operator");
        return { empty, first, second, read, cleared, after: yield* r.briefingRead(), references: yield* r.list(APP_REFERENCE_PLACE) };
      }),
    );
    expect(result.empty).toBeNull();
    expect(result.first?.body.length).toBeGreaterThan(300_000);
    expect(result.first?.body.startsWith("# House rules\nline")).toBe(true);
    expect(result.read).toEqual(result.second);
    expect(result.read?.body).toBe("Short now.");
    expect(result.cleared).toBeNull();
    expect(result.after).toBeNull();
    // The briefing is never one of the references.
    expect(result.references).toEqual([]);
  });

  it("writes, lists by name, replaces and deletes app references", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* ReferencesRepository;
        yield* r.write(APP_REFERENCE_PLACE, { name: "Style", description: " How we write ", body: "Plain words.\r\n" }, "operator");
        yield* r.write(APP_REFERENCE_PLACE, { name: "release", body: "Ship on green." }, "operator");
        const listed = yield* r.list(APP_REFERENCE_PLACE);
        // Replacing drops a description that is no longer given.
        const replaced = yield* r.write(APP_REFERENCE_PLACE, { name: "STYLE", body: "Plainer words." }, "overseer:agent-1");
        const read = yield* r.read(APP_REFERENCE_PLACE, "Style");
        const missing = yield* r.read(APP_REFERENCE_PLACE, "nope");
        const removed = yield* r.remove(APP_REFERENCE_PLACE, "style");
        const again = yield* r.remove(APP_REFERENCE_PLACE, "style");
        return { listed, replaced, read, missing, removed, again, after: yield* r.list(APP_REFERENCE_PLACE) };
      }),
    );
    expect(result.listed.map(({ updatedAt: _, ...rest }) => rest)).toEqual([
      { name: "release", body: "Ship on green." },
      { name: "style", description: "How we write", body: "Plain words." },
    ]);
    expect(result.replaced).toMatchObject({ name: "style", body: "Plainer words." });
    expect(result.replaced).not.toHaveProperty("description");
    expect(result.read).toEqual(result.replaced);
    expect(result.missing).toBeNull();
    expect([result.removed, result.again]).toEqual([true, false]);
    expect(result.after.map((reference) => reference.name)).toEqual(["release"]);
  });

  it("refuses a name that is not one and a write with no body, in words that say what to do", async () => {
    const [badName, noBody, badRead] = await Promise.all([
      failure(Effect.flatMap(ReferencesRepository, (r) => r.write(APP_REFERENCE_PLACE, { name: "two words", body: "b" }, "operator"))),
      failure(Effect.flatMap(ReferencesRepository, (r) => r.write(APP_REFERENCE_PLACE, { name: "style", body: "  " }, "operator"))),
      failure(Effect.flatMap(ReferencesRepository, (r) => r.read(APP_REFERENCE_PLACE, ""))),
    ]);
    expect(badName).toMatchObject({ _tag: "ReferenceRefused" });
    expect(noBody).toMatchObject({ _tag: "ReferenceRefused", message: expect.stringContaining("delete it") });
    expect(badRead).toMatchObject({ _tag: "ReferenceRefused" });
  });

  it("keeps the app, each region and each canvas apart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* ReferencesRepository;
        yield* r.write(APP_REFERENCE_PLACE, { name: "style", body: "App style." }, "operator");
        yield* r.write(region("outer"), { name: "style", body: "Outer style." }, "operator");
        yield* r.write(region("inner"), { name: "style", body: "Inner style." }, "operator");
        yield* r.write(region("inner"), { name: "runbook", body: "Inner runbook." }, "operator");
        yield* r.write(region("inner", "other"), { name: "style", body: "Other canvas." }, "operator");
        yield* r.remove(region("outer"), "style");
        return {
          app: yield* r.list(APP_REFERENCE_PLACE),
          outer: yield* r.list(region("outer")),
          inner: yield* r.list(region("inner")),
          texts: yield* r.regionTexts("factory", ["outer", "inner", "gone"]),
          none: yield* r.regionTexts("factory", []),
        };
      }),
    );
    expect(result.app.map((reference) => reference.body)).toEqual(["App style."]);
    expect(result.outer).toEqual([]);
    expect(result.inner.map((reference) => reference.name)).toEqual(["runbook", "style"]);
    expect(result.texts.map((reference) => [reference.regionId, reference.name, reference.body])).toEqual([
      ["inner", "runbook", "Inner runbook."],
      ["inner", "style", "Inner style."],
    ]);
    expect(result.none).toEqual([]);
  });
});

describe("what a seat has in scope", () => {
  const at = (name: string, body: string, description?: string) => ({
    name,
    body,
    updatedAt: 1,
    ...(description !== undefined ? { description } : {}),
  });
  const outer = { id: "outer", label: "CLI" };
  const inner = { id: "inner", label: "Protocol" };

  it("is the app then each region outer to inner, and the inner one wins a name where the outer one stood", () => {
    const scoped = referencesInScope({
      app: [at("release", "App release."), at("style", "App style.", "How we write")],
      regions: [outer, inner],
      regional: [
        { ...at("style", "Inner style."), regionId: "inner" },
        { ...at("runbook", "Outer runbook."), regionId: "outer" },
        { ...at("style", "Outer style."), regionId: "outer" },
        // A region the seat is not in is never listed.
        { ...at("secret-plans", "Elsewhere."), regionId: "elsewhere" },
      ],
    });
    expect(scoped.map((reference) => [reference.name, reference.scope, reference.region?.id, reference.body])).toEqual([
      ["release", "app", undefined, "App release."],
      ["style", "region", "inner", "Inner style."],
      ["runbook", "region", "outer", "Outer runbook."],
    ]);
  });

  it("lists names and descriptions with the command that reads each, never a body", () => {
    const [app, regional] = referencesInScope({
      app: [at("style", "Plain wörds.", "How we write")],
      regions: [inner],
      regional: [{ ...at("runbook", "Steps."), regionId: "inner" }],
    });
    expect(toReferenceListing(app!)).toEqual({
      name: "style",
      description: "How we write",
      scope: "app",
      read: "junto references read style",
    });
    expect(toReferenceListing(regional!)).toEqual({
      name: "runbook",
      scope: "region",
      region: inner,
      read: "junto references read runbook",
    });
    expect(toReferenceListEntry(app!)).toMatchObject({ bytes: 13, updatedAt: 1 });
    expect(JSON.stringify(toReferenceListing(app!))).not.toContain("Plain");
  });
});
