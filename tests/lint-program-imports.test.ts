import { describe, expect, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin, { importViolation, packageOf, programOf, targetOf, type ProgramImportsOptions } from "../lint/junto-plugin";

const options: ProgramImportsOptions = {
  root: "/repo",
  aliases: { "@shared/*": "src/shared/*", "@renderer/*": "src/renderer/*", "@junto/overlay": "src/overlay-oss/index.ts" },
  programs: [
    { name: "shared", paths: ["src/shared/"], forbidModules: ["electron"] },
    { name: "window", paths: ["src/renderer/"], mayImport: ["shared"], forbidModules: ["electron"] },
    { name: "app", paths: ["src/main/"], mayImport: ["shared", "core"] },
    { name: "core", paths: ["src/main/core-process/ops/", "src/main/core-process/entry.ts"], mayImport: ["shared", "app"], forbidModules: ["electron"] },
    { name: "overlay", paths: ["src/overlay-oss/"] },
  ],
};

describe("program imports", () => {
  it("place a file by its longest prefix, files named whole", () => {
    expect(programOf(options.programs, "src/main/junto/core.ts")?.name).toBe("app");
    expect(programOf(options.programs, "src/main/core-process/ops/files.ts")?.name).toBe("core");
    expect(programOf(options.programs, "src/main/core-process/entry.ts")?.name).toBe("core");
    expect(programOf(options.programs, "src/main/core-process/entry-old.ts")?.name).toBe("app");
    expect(programOf(options.programs, "tests/x.test.ts")).toBeUndefined();
  });

  it("resolve relative, aliased and package specifiers", () => {
    expect(targetOf("../../junto/core", "src/main/core-process/ops/files.ts", {})).toEqual({ kind: "path", rel: "src/main/junto/core" });
    expect(targetOf("@renderer/lib/fuzzy-match", "src/main/x.ts", options.aliases!)).toEqual({ kind: "path", rel: "src/renderer/lib/fuzzy-match" });
    expect(targetOf("@junto/overlay", "src/main/x.ts", options.aliases!)).toEqual({ kind: "path", rel: "src/overlay-oss/index.ts" });
    expect(targetOf("./index-worker?nodeWorker", "src/main/a/b.ts", {})).toEqual({ kind: "path", rel: "src/main/a/index-worker" });
    expect(packageOf("@xterm/headless/lib")).toBe("@xterm/headless");
    expect(packageOf("electron/main")).toBe("electron");
  });

  it("refuse what a program may not reach, and allow the rest", () => {
    expect(importViolation(options, "src/main/core-process/ops/files.ts", "electron")).toBe('the core program never loads "electron"');
    expect(importViolation(options, "src/main/index.ts", "electron")).toBeUndefined();
    expect(importViolation(options, "src/main/junto/a.ts", "@renderer/lib/fuzzy-match")).toBe(
      "the app program may not import the window program (src/renderer/lib/fuzzy-match)",
    );
    expect(importViolation(options, "src/shared/a.ts", "../main/junto/core")).toBe("the shared program may not import the app program (src/main/junto/core)");
    expect(importViolation(options, "src/renderer/a.ts", "@shared/ipc")).toBeUndefined();
    expect(importViolation(options, "tests/a.test.ts", "electron")).toBeUndefined();
  });
});

// RuleTester types options as JSON; the options are plain JSON data.
const ruleOptions = [options] as never;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester();
const rule = plugin.rules["program-imports"];
tester.run("junto/program-imports", rule as never, {
  valid: [
    { code: 'import type { MessagePortMain } from "electron";', filename: "/repo/src/main/core-process/ops/a.ts", options: ruleOptions },
    { code: 'import { type BrowserWindow } from "electron";', filename: "/repo/src/main/core-process/ops/a.ts", options: ruleOptions },
    { code: 'import { app } from "electron";', filename: "/repo/src/main/index.ts", options: ruleOptions },
    { code: 'import { x } from "@shared/ipc";', filename: "/repo/src/renderer/a.ts", options: ruleOptions },
  ],
  invalid: [
    {
      code: 'import { utilityProcess } from "electron";',
      filename: "/repo/src/main/core-process/ops/a.ts",
      options: ruleOptions,
      errors: [{ message: 'the core program never loads "electron"' }],
    },
    {
      code: 'export { fuzzy } from "@renderer/lib/fuzzy-match";\nconst late = import("../renderer/x");',
      filename: "/repo/src/main/a.ts",
      options: ruleOptions,
      errors: [
        { message: "the app program may not import the window program (src/renderer/lib/fuzzy-match)" },
        { message: "the app program may not import the window program (src/renderer/x)" },
      ],
    },
  ],
});
