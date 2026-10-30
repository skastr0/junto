#!/usr/bin/env bun
// Builds the Junto kit (src/renderer/kit) into dist/kit as a package the
// website and docs install: an ES module, one stylesheet that also works in
// a shadow root, and declarations. bun run kit:build
//
//   dist/kit/index.js       React and react-dom stay the host's
//   dist/kit/learn.js       the lessons' schema alone, no React
//   dist/kit/kit.css        tokens, utilities and the seat, ring, bubble rules
//   dist/kit/index.d.ts     declarations, rolled into one file per entry
//   dist/kit/learn.d.ts
//   dist/kit/package.json   "@junto/kit", pinned to this commit
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Extractor, ExtractorConfig, type ExtractorLogLevel } from "@microsoft/api-extractor";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist", "kit");
// tsc's declarations, one per source file; rolled up, then removed.
const types = join(out, "types");

const run = (command: string, args: ReadonlyArray<string>): void => {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
};

run("bunx", ["vite", "build", "-c", "vite.kit.config.ts"]);
run("bunx", ["tsc", "-p", "tsconfig.kit.json"]);

/** `@shared/x` in a declaration at `file`, as a path from that file. */
const ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(["'])@shared\/([^"']+)\1/g, "shared"],
  [/(["'])@renderer\/([^"']+)\1/g, "renderer"],
];

const declarations = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return declarations(path);
    return path.endsWith(".d.ts") ? [path] : [];
  });

for (const file of declarations(types)) {
  let text = readFileSync(file, "utf8");
  for (const [pattern, folder] of ALIASES) {
    text = text.replace(pattern, (_match, quote: string, rest: string) => {
      const target = relative(dirname(file), join(types, folder, rest));
      return `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`;
    });
  }
  // Stylesheets ship as kit.css; a declaration has no use for them.
  text = text.replace(/^import ["'][^"']+\.css["'];\n/gm, "");
  writeFileSync(file, text);
}

// One declaration file per entry, holding only what its exports reach: the
// app's protocol schemas sit behind the views' imports but never in their
// types. api-extractor carries its own TypeScript, so the app's 7 is no bar.
for (const entry of ["index", "learn"]) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: out,
      mainEntryPointFilePath: join(types, "renderer", "kit", `${entry}.d.ts`),
      bundledPackages: [],
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            strict: true,
            skipLibCheck: true,
            types: [],
          },
          include: [join(types, "**", "*.d.ts")],
        },
      },
      dtsRollup: { enabled: true, untrimmedFilePath: join(out, `${entry}.d.ts`) },
      apiReport: { enabled: false },
      docModel: { enabled: false },
      tsdocMetadata: { enabled: false },
      // The kit's comments are prose, not TSDoc, and it has no release tags.
      messages: {
        extractorMessageReporting: { default: { logLevel: "none" as ExtractorLogLevel } },
        tsdocMessageReporting: { default: { logLevel: "none" as ExtractorLogLevel } },
      },
    },
    configObjectFullPath: undefined,
    packageJson: { name: "@junto/kit", version: "0.0.0" },
    packageJsonFullPath: join(out, "package.json"),
  });
  const result = Extractor.invoke(config, { localBuild: true });
  if (!result.succeeded) throw new Error(`kit: ${entry}.d.ts has ${result.errorCount} declaration errors`);
}
rmSync(types, { recursive: true });

const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  readonly version: string;
  readonly license: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const react = String(app.dependencies?.react ?? app.devDependencies?.react).replace(/^[\^~]/, "");
// The host's React from the app's minor on: the views use nothing newer.
const reactRange = `^${react.split(".").slice(0, 2).join(".")}.0`;

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "@junto/kit",
      version: app.version,
      description: "Junto's seats, rings, bubbles and wire pulses as pure React views, as the app draws them.",
      license: app.license,
      private: true,
      type: "module",
      junto: { commit },
      sideEffects: ["*.css"],
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
        "./learn": { types: "./learn.d.ts", import: "./learn.js" },
        "./kit.css": "./kit.css",
      },
      peerDependencies: { react: reactRange, "react-dom": reactRange },
    },
    null,
    2,
  )}\n`,
);

console.log(`kit: dist/kit at ${commit.slice(0, 9)}`);
