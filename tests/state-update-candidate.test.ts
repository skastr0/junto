import { existsSync, lstatSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareStateUpdateCandidate,
  releaseStateUpdateCandidate,
  withStateUpdateCandidate,
} from "../src/main/vellum/state/update-candidate";
import { STATE_SCHEMA_V1_SQL } from "../src/main/vellum/state/schema";
import { verifyAndStampStateSchema } from "../src/main/vellum/state/schema-identity";

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

    const candidate = await Effect.runPromise(
      prepareStateUpdateCandidate(layout.databasePath),
    );
    expect(candidate.source._tag).toBe("installed");
    if (candidate.source._tag !== "installed") {
      throw new Error("expected installed source");
    }
    expect(candidate.source.backup.path).not.toBe(candidate.databasePath);
    expect(lstatSync(candidate.source.backup.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(candidate.databasePath).mode & 0o777).toBe(0o600);

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

  it("prepares a fresh disposable database without manufacturing a backup", async () => {
    const layout = await makeRoot();
    const result = await Effect.runPromise(
      withStateUpdateCandidate(
        (candidate) =>
          Effect.sync(() => ({
            source: candidate.source._tag,
            candidatePath: candidate.databasePath,
            candidateDirectory: candidate.directoryPath,
          })),
        layout.databasePath,
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
          layout.databasePath,
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

    const exit = await Effect.runPromise(
      Effect.exit(prepareStateUpdateCandidate(layout.databasePath)),
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
    const candidate = await Effect.runPromise(
      prepareStateUpdateCandidate(layout.databasePath),
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
