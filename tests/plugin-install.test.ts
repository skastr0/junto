import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitDesiredTargetPath,
  applyDesiredFilesLocal,
  compilePluginPackage,
  contentHash,
  installVellumPlugin,
  PathSafetyError,
} from "../src/main/vellum/plugin-install";
import type { DesiredFile } from "../src/main/vellum/plugin-install";

/** Dummy path — precompiled payloads ignore pluginPath. */
const fixturePlugin = resolve(
  import.meta.dirname,
  "fixtures/minimal-prism-plugin",
);

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-plugin-install-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

const runExit = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect);

describe("admitDesiredTargetPath", () => {
  it("refuses relative paths without a confinement root", async () => {
    const exit = await runExit(admitDesiredTargetPath("foo/bar.txt"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      // extract PathSafetyError via Effect failure
      expect(String(error)).toMatch(/relative target path requires a confinement root|PathSafetyError/);
    }
  });

  it("refuses escape outside confinement root", async () => {
    const root = await tempRoot();
    const exit = await runExit(
      admitDesiredTargetPath("../escape.txt", { root }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("admits paths under confinement root", async () => {
    const root = await tempRoot();
    const path = await run(
      admitDesiredTargetPath("nested/file.txt", { root }),
    );
    expect(path).toBe(resolve(root, "nested/file.txt"));
  });

  it("admits absolute paths without root", async () => {
    const root = await tempRoot();
    const absolute = join(root, "abs.txt");
    const path = await run(admitDesiredTargetPath(absolute));
    expect(path).toBe(resolve(absolute));
  });
});

describe("applyDesiredFilesLocal", () => {
  it("writes files and is idempotent on second apply", async () => {
    const root = await tempRoot();
    const files: DesiredFile[] = [
      {
        targetPath: join(root, "skills", "hello.md"),
        content: "# Hello\n",
        mode: 0o644,
        plugin: "test",
      },
      {
        targetPath: join(root, "skills", "nested", "rule.md"),
        content: "rule body\n",
        plugin: "test",
      },
    ];

    const first = await run(applyDesiredFilesLocal({ files }));
    expect(first.applied).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.operations.every((op) => op.type === "write")).toBe(true);
    expect(await readFile(files[0]!.targetPath, "utf8")).toBe("# Hello\n");
    expect(await readFile(files[1]!.targetPath, "utf8")).toBe("rule body\n");

    const second = await run(applyDesiredFilesLocal({ files }));
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.operations.every((op) => op.type === "skip")).toBe(true);
    expect(second.operations.every((op) => op.reason === "unchanged")).toBe(true);
  });

  it("updates when content changes", async () => {
    const root = await tempRoot();
    const targetPath = join(root, "a.txt");
    await run(
      applyDesiredFilesLocal({
        files: [{ targetPath, content: "v1\n", plugin: "test" }],
      }),
    );
    const second = await run(
      applyDesiredFilesLocal({
        files: [{ targetPath, content: "v2\n", plugin: "test" }],
      }),
    );
    expect(second.applied).toBe(1);
    expect(second.skipped).toBe(0);
    expect(await readFile(targetPath, "utf8")).toBe("v2\n");
  });

  it("refuses path escape when root is set", async () => {
    const root = await tempRoot();
    const outside = join(root, "..", "escape.txt");
    const exit = await runExit(
      applyDesiredFilesLocal({
        root,
        files: [
          {
            targetPath: outside,
            content: "nope\n",
            plugin: "test",
          },
        ],
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("confines relative paths under root", async () => {
    const root = await tempRoot();
    const receipt = await run(
      applyDesiredFilesLocal({
        root,
        files: [
          {
            targetPath: "rel/path.txt",
            content: "relative\n",
            plugin: "test",
          },
        ],
      }),
    );
    expect(receipt.applied).toBe(1);
    expect(await readFile(join(root, "rel/path.txt"), "utf8")).toBe("relative\n");
  });
});

describe("contentHash", () => {
  it("is stable for identical content", () => {
    expect(contentHash("a\n")).toBe(contentHash("a\n"));
    expect(contentHash("a\n")).not.toBe(contentHash("b\n"));
  });
});

describe("rehomeDesiredFiles", () => {
  it("maps absolute plan paths under applyRoot", async () => {
    const { rehomeDesiredFiles } = await import("../src/main/vellum/plugin-install/paths");
    const planRoot = "/tmp/plan-aaa";
    const dest = "/tmp/apply-bbb";
    const remapped = rehomeDesiredFiles(
      [
        {
          targetPath: `${planRoot}/skills/foo/SKILL.md`,
          content: "x",
          plugin: "vellum",
        },
      ],
      [planRoot],
      dest,
    );
    expect(remapped[0]?.targetPath).toBe(`${dest}/skills/foo/SKILL.md`);
  });
});

describe("compilePluginPackage", () => {
  it("loads frozen precompiled payload for claude-code (no Bun)", async () => {
    const result = await run(
      compilePluginPackage({
        pluginPath: fixturePlugin,
        target: "claude-code",
      }),
    );
    expect(result.target).toBe("claude-code");
    expect(result.packageId).toContain("prism-generated-vellum");
    expect(result.compileFiles.length).toBeGreaterThan(0);
    for (const file of result.compileFiles) {
      expect(file.targetPath.length).toBeGreaterThan(0);
      expect(file.content.length).toBeGreaterThan(0);
    }
  });

  it("loads frozen precompiled payload for codex-cli", async () => {
    const result = await run(
      compilePluginPackage({
        pluginPath: fixturePlugin,
        target: "codex-cli",
      }),
    );
    expect(result.target).toBe("codex-cli");
    expect(
      result.compileFiles.length + result.compileRegions.length,
    ).toBeGreaterThan(0);
  });

  it("loads all fleet harness payloads", async () => {
    for (const target of ["claude-code", "codex-cli", "grok", "hermes"] as const) {
      const result = await run(
        compilePluginPackage({ pluginPath: "unused", target }),
      );
      expect(result.target).toBe(target);
      expect(result.compileFiles.length).toBeGreaterThan(0);
    }
  });
});

describe("installVellumPlugin local", () => {
  it("applies precompiled files under applyRoot; second run skips", async () => {
    const root = await tempRoot();
    const first = await run(
      installVellumPlugin({
        pluginPath: fixturePlugin,
        target: "claude-code",
        mode: "local",
        applyRoot: root,
      }),
    );

    expect(first.target).toBe("claude-code");
    expect(first.applied + first.skipped).toBe(first.operations.length);
    expect(first.operations.length).toBeGreaterThan(0);
    expect(first.applied).toBeGreaterThan(0);
    for (const op of first.operations) {
      if (op.type === "write") {
        const body = await readFile(op.path, "utf8");
        expect(body.length).toBeGreaterThan(0);
      }
    }

    const second = await run(
      installVellumPlugin({
        pluginPath: fixturePlugin,
        target: "claude-code",
        mode: "local",
        applyRoot: root,
      }),
    );
    expect(second.skipped).toBe(second.operations.length);
    expect(second.applied).toBe(0);
  });
});

describe("PathSafetyError shape", () => {
  it("is a tagged error", async () => {
    const exit = await runExit(admitDesiredTargetPath("rel-only"));
    expect(Exit.isFailure(exit)).toBe(true);
    await Effect.runPromise(
      admitDesiredTargetPath("rel-only").pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(PathSafetyError);
          expect(error._tag).toBe("PathSafetyError");
        }),
      ),
    );
  });
});
