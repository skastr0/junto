import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const runEither = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect));

describe("browser profile registry", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const fresh = async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-"));
    return makeBrowserProfileService(root);
  };

  it("ensureDefaults creates personal and work", async () => {
    const svc = await fresh();
    const config = await run(svc.ensureDefaults);
    expect(config.defaultProfile).toBe("personal");
    expect(config.profiles.map((p) => p.id).sort()).toEqual(["personal", "work"]);
    expect(config.maxWarmSessions).toBe(3);
    expect(config.maxVisibleSurfaces).toBe(2);
    const raw = await readFile(join(root, "config.json"), "utf8");
    expect(JSON.parse(raw).defaultProfile).toBe("personal");
  });

  it("createProfile adds a new profile", async () => {
    const svc = await fresh();
    await run(svc.ensureDefaults);
    const created = await run(svc.createProfile("lab", "Lab"));
    expect(created.id).toBe("lab");
    expect(created.label).toBe("Lab");
    const list = await run(svc.listProfiles);
    expect(list.map((p) => p.id)).toContain("lab");
  });

  it("rejects invalid profile ids", async () => {
    const svc = await fresh();
    await run(svc.ensureDefaults);
    const result = await runEither(svc.createProfile("Bad Id"));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("BrowserProfileError");
      expect(result.left.code).toBe("invalid");
    }
  });

  it("partitionName is stable for known profiles", async () => {
    const svc = await fresh();
    await run(svc.ensureDefaults);
    const name = await run(svc.partitionName("work"));
    expect(name).toBe("persist:vellum-profile-work");
  });

  it("partitionName fails for unknown profile", async () => {
    const svc = await fresh();
    await run(svc.ensureDefaults);
    const result = await runEither(svc.partitionName("nope"));
    expect(Either.isLeft(result)).toBe(true);
  });

  it("resolveDefaultProfile uses canvasDefaults when set", async () => {
    const svc = await fresh();
    const config = await run(svc.ensureDefaults);
    // write canvas default via create + manual config rewrite through create then touch path
    // use internal write by re-reading after create and... we need canvasDefaults API.
    // ensureDefaults already wrote; inject via createProfile + raw file edit is ok in test.
    const path = join(root, "config.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    raw.canvasDefaults = { portfolio: "work" };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    const resolved = await run(svc.resolveDefaultProfile("portfolio"));
    expect(resolved).toBe("work");
    const fallback = await run(svc.resolveDefaultProfile("other"));
    expect(fallback).toBe("personal");
  });

  it("wipeProfile removes dir and refuses last profile", async () => {
    const svc = await fresh();
    await run(svc.ensureDefaults);
    await run(svc.createProfile("temp"));
    await run(svc.wipeProfile("temp"));
    const list = await run(svc.listProfiles);
    expect(list.map((p) => p.id)).not.toContain("temp");

    // wipe all but one, then last wipe fails
    await run(svc.wipeProfile("work"));
    const only = await run(svc.listProfiles);
    expect(only).toHaveLength(1);
    const result = await runEither(svc.wipeProfile(only[0]!.id));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("forbidden");
    }
  });

  it("touchProfile updates lastUsedAt", async () => {
    const svc = await fresh();
    await run(svc.ensureDefaults);
    await run(svc.touchProfile("personal"));
    const list = await run(svc.listProfiles);
    const personal = list.find((p) => p.id === "personal");
    expect(personal?.lastUsedAt).toBeTruthy();
  });

  it("doctor reports root", async () => {
    const svc = await fresh();
    const check = await run(svc.doctor);
    expect(check.id).toBe("browser-profiles");
    expect(check.status).toBe("ok");
    expect(check.detail).toBe(root);
  });
});
