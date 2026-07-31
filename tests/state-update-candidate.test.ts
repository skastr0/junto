import { existsSync, lstatSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareStateUpdateCandidate,
  releaseStateUpdateCandidate,
  withStateUpdateCandidate,
} from "../src/main/vellum/state/update-candidate";
import { STATE_SCHEMA_V1_SQL } from "../src/main/vellum/state/schema";
import { verifyAndStampStateSchema } from "../src/main/vellum/state/schema-identity";

const candidateSource = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/main/vellum/state/engine", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main/vellum/state/engine")
  >()),
  stateDatabasePath: () => candidateSource.path,
}));

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const makeRoot = async (): Promise<{
  readonly root: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
}> => {
  const root = await mkdtemp(
    join(tmpdir(), "vellum-state-update-candidate-"),
  );
  roots.push(root);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  return {
    root,
    stateDirectory,
    databasePath: join(stateDirectory, "vellum.db"),
  };
};

const seedVersionOne = (path: string): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec(STATE_SCHEMA_V1_SQL);
    database.prepare(
      `
        INSERT INTO canvas_generations(
          generation,
          created_at,
          cause,
          intent_sha256,
          document_count
        ) VALUES ('1', '2026-07-28T00:00:00.000Z', 'test', ?, 0)
      `,
    ).run("a".repeat(64));
    database.prepare(
      "INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')",
    ).run();
    verifyAndStampStateSchema(database, STATE_SCHEMA_V1_SQL);
    database.exec("PRAGMA user_version = 1");
  } finally {
    database.close();
  }
};

describe("state update candidate", () => {
  it("mints a retained verified backup and a separate disposable clone", async () => {
    const layout = await makeRoot();
    seedVersionOne(layout.databasePath);
    candidateSource.path = layout.databasePath;

    const candidate = await Effect.runPromise(
      prepareStateUpdateCandidate(),
    );
    expect(candidate.source._tag).toBe("installed");
    if (candidate.source._tag !== "installed") {
      throw new Error("expected installed source");
    }
    expect(candidate.source.backup.path).not.toBe(candidate.databasePath);
    expect(lstatSync(candidate.source.backup.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(candidate.databasePath).mode & 0o777).toBe(0o600);
    expect(await readdir(join(layout.stateDirectory, "backups"))).toEqual([
      basename(candidate.source.backup.path),
    ]);

    const clone = new DatabaseSync(candidate.databasePath);
    try {
      clone.prepare(
        "UPDATE canvas_generations SET cause = 'candidate-only' WHERE generation = '1'",
      ).run();
    } finally {
      clone.close();
    }

    const installed = new DatabaseSync(layout.databasePath, {
      readOnly: true,
    });
    const backup = new DatabaseSync(candidate.source.backup.path, {
      readOnly: true,
    });
    try {
      expect(
        installed.prepare(
          "SELECT cause FROM canvas_generations WHERE generation = '1'",
        ).get(),
      ).toEqual({ cause: "test" });
      expect(
        backup.prepare(
          "SELECT cause FROM canvas_generations WHERE generation = '1'",
        ).get(),
      ).toEqual({ cause: "test" });
    } finally {
      installed.close();
      backup.close();
    }

    await Effect.runPromise(releaseStateUpdateCandidate(candidate));
    expect(existsSync(candidate.directoryPath)).toBe(false);
    expect(existsSync(candidate.source.backup.path)).toBe(true);
  });

  it("reconciles only recognized interrupted update artifacts", async () => {
    const layout = await makeRoot();
    seedVersionOne(layout.databasePath);
    candidateSource.path = layout.databasePath;

    const first = await Effect.runPromise(prepareStateUpdateCandidate());
    if (first.source._tag !== "installed") {
      throw new Error("expected installed source");
    }
    const retainedBackup = first.source.backup.path;
    const retainedBytes = await readFile(retainedBackup);
    await Effect.runPromise(releaseStateUpdateCandidate(first));

    const pendingBackup = join(
      layout.stateDirectory,
      "backups",
      "vellum-backup-11111111-1111-4111-8111-111111111111.db.pending",
    );
    await writeFile(pendingBackup, "interrupted backup", { mode: 0o600 });
    const versionOneLookalike = join(
      layout.stateDirectory,
      "backups",
      "vellum-backup-11111111-1111-1111-8111-111111111111.db.pending",
    );
    const versionFiveLookalike = join(
      layout.stateDirectory,
      "backups",
      "vellum-backup-55555555-5555-5555-8555-555555555555.db.pending",
    );
    await writeFile(versionOneLookalike, "not minted by Vellum Command", {
      mode: 0o600,
    });
    await writeFile(versionFiveLookalike, "not minted by Vellum Command", {
      mode: 0o600,
    });

    const candidatesRoot = join(
      layout.stateDirectory,
      "update-candidates",
    );
    const orphan = join(
      candidatesRoot,
      "22222222-2222-4222-8222-222222222222",
    );
    await mkdir(join(orphan, "backups"), { recursive: true });
    await writeFile(join(orphan, "vellum.db"), "interrupted clone", {
      mode: 0o600,
    });
    await writeFile(
      join(
        orphan,
        "backups",
        "vellum-backup-33333333-3333-4333-8333-333333333333.db.pending",
      ),
      "interrupted clone backup",
      { mode: 0o600 },
    );

    const unrelated = join(candidatesRoot, "operator-note");
    await mkdir(unrelated);
    const witness = join(unrelated, "must-survive");
    await writeFile(witness, "not a Vellum Command candidate");
    const versionOneCandidate = join(
      candidatesRoot,
      "11111111-1111-1111-8111-111111111111",
    );
    const versionFiveCandidate = join(
      candidatesRoot,
      "55555555-5555-5555-8555-555555555555",
    );
    await mkdir(versionOneCandidate);
    await mkdir(versionFiveCandidate);
    const versionOneWitness = join(versionOneCandidate, "must-survive");
    const versionFiveWitness = join(versionFiveCandidate, "must-survive");
    await writeFile(versionOneWitness, "not a minted candidate");
    await writeFile(versionFiveWitness, "not a minted candidate");

    const second = await Effect.runPromise(prepareStateUpdateCandidate());

    expect(existsSync(pendingBackup)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(await readFile(retainedBackup)).toEqual(retainedBytes);
    expect(await readFile(witness, "utf8")).toBe("not a Vellum Command candidate");
    expect(await readFile(versionOneLookalike, "utf8")).toBe(
      "not minted by Vellum Command",
    );
    expect(await readFile(versionFiveLookalike, "utf8")).toBe(
      "not minted by Vellum Command",
    );
    expect(await readFile(versionOneWitness, "utf8")).toBe(
      "not a minted candidate",
    );
    expect(await readFile(versionFiveWitness, "utf8")).toBe(
      "not a minted candidate",
    );

    await Effect.runPromise(releaseStateUpdateCandidate(second));
  });

  it("preserves and rejects an unrecognized entry inside an orphan candidate", async () => {
    const layout = await makeRoot();
    candidateSource.path = layout.databasePath;
    const orphan = join(
      layout.stateDirectory,
      "update-candidates",
      "44444444-4444-4444-8444-444444444444",
    );
    await mkdir(orphan, { recursive: true });
    const witness = join(orphan, "operator-data");
    await writeFile(witness, "must survive");

    const exit = await Effect.runPromise(
      Effect.exit(prepareStateUpdateCandidate()),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain(
        "state update candidate contains an unexpected entry",
      );
    }
    expect(await readFile(witness, "utf8")).toBe("must survive");
  });

  it("prepares a fresh disposable database without manufacturing a backup", async () => {
    const layout = await makeRoot();
    candidateSource.path = layout.databasePath;
    const result = await Effect.runPromise(
      withStateUpdateCandidate(
        (candidate) =>
          Effect.sync(() => ({
            source: candidate.source._tag,
            candidatePath: candidate.databasePath,
            candidateDirectory: candidate.directoryPath,
          })),
      ),
    );

    expect(result.source).toBe("fresh");
    expect(existsSync(result.candidatePath)).toBe(false);
    expect(existsSync(result.candidateDirectory)).toBe(false);
    expect(existsSync(join(layout.stateDirectory, "backups"))).toBe(false);
  });

  it("cleans only the disposable clone when candidate use fails", async () => {
    const layout = await makeRoot();
    seedVersionOne(layout.databasePath);
    candidateSource.path = layout.databasePath;
    let candidateDirectory = "";
    let backupPath = "";

    const exit = await Effect.runPromise(
      Effect.exit(
        withStateUpdateCandidate(
          (candidate) => {
            candidateDirectory = candidate.directoryPath;
            if (candidate.source._tag === "installed") {
              backupPath = candidate.source.backup.path;
            }
            return Effect.fail("candidate refused");
          },
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(existsSync(candidateDirectory)).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    expect(await readdir(join(layout.stateDirectory, "backups"))).toHaveLength(
      1,
    );
  });

  it("rejects a symlink in place of the installed database", async () => {
    const layout = await makeRoot();
    const target = join(layout.root, "target.db");
    seedVersionOne(target);
    const { symlink } = await import("node:fs/promises");
    await symlink(target, layout.databasePath);
    candidateSource.path = layout.databasePath;

    const exit = await Effect.runPromise(
      Effect.exit(prepareStateUpdateCandidate()),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain(
        "state update source is not a regular file",
      );
    }
    expect(existsSync(target)).toBe(true);
  });

  it("makes recursive cleanup authority unforgeable from candidate fields", async () => {
    const layout = await makeRoot();
    const id = "00000000-0000-4000-8000-000000000001";
    const directoryPath = join(
      layout.stateDirectory,
      "update-candidates",
      id,
    );
    await mkdir(directoryPath, { recursive: true });
    const witness = join(directoryPath, "must-survive");
    await writeFile(witness, "operator data");

    const exit = await Effect.runPromise(
      Effect.exit(
        releaseStateUpdateCandidate({
          id: id as never,
          directoryPath,
          databasePath: join(directoryPath, "vellum.db"),
          source: { _tag: "fresh" },
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("requires minted authority");
    }
    expect(existsSync(witness)).toBe(true);
  });

  it("refuses to remove a replacement at a minted candidate path", async () => {
    const layout = await makeRoot();
    candidateSource.path = layout.databasePath;
    const candidate = await Effect.runPromise(
      prepareStateUpdateCandidate(),
    );
    await rm(candidate.directoryPath, { recursive: true, force: true });
    await mkdir(candidate.directoryPath);
    const witness = join(candidate.directoryPath, "replacement");
    await writeFile(witness, "must survive");

    const exit = await Effect.runPromise(
      Effect.exit(releaseStateUpdateCandidate(candidate)),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("changed identity");
    }
    expect(existsSync(witness)).toBe(true);
  });
});
