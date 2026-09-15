/**
 * Isolated real-Devin generated-canvas fixture. Disjoint from fake-tui
 * crew-fixture.ts. Adapter seed does not flip typedNoticeQualified.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { prepareIsolatedHarnessLaunch } from "../../src/main/vellum-command/term/isolated-harness-launch";
import { templateFor } from "../../src/shared/managed-terminal-templates";
import { agentTextNode, verbEdge, type Sandbox } from "./sandbox";
import { seededHarnessBinDir } from "./agent-harness-fixture";
import { installCrewSeatHarness } from "./crew-fixture";

export const ISOLATED_DEVIN_MAIL_CANVAS = "isolated-devin-mail";
export const ISOLATED_DEVIN_SENDER_ID = "seat-sender";
export const ISOLATED_DEVIN_RECEIVER_ID = "seat-devin";
export const ISOLATED_DEVIN_CREDENTIAL_REL = ".local/share/devin/credentials.toml";

const FIXTURE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_BUILD_HINT =
  "Build the matching Vellum Command CLI first: VELLUM_COMMAND_FEATURE_PROFILE=all-on bun scripts/build-standalone-cli.ts vellum-command";
const CliBuildReceipt = Schema.Struct({
  schema: Schema.Literal("vellum-command/cli-relink/v1"),
  sourceCommit: Schema.String,
  featureProfile: Schema.Literal("all-on"),
  binary: Schema.Struct({ bytes: Schema.Number, sha256: Schema.String }),
});

/**
 * electron-vite does not build the standalone CLI. Use the same compiled
 * artifact a packaged app ships, verified against this checkout, never an
 * operator install or a fake response. Preserve a sandbox copy and receipt;
 * the app puts .local/bin on PATH, and may prepend the same checkout's dist.
 * Both build directories must remain frozen while observing the native run.
 */
export const seedIsolatedVellumCli = async (
  sandbox: Sandbox,
  repoRoot: string = FIXTURE_REPO_ROOT,
) => {
  const source = join(repoRoot, "dist", "vellum-command");
  const receiptSource = `${source}-relink.json`;
  if (!existsSync(source) || !existsSync(receiptSource)) {
    throw new Error(`Isolated Devin has no compiled Vellum Command CLI. ${CLI_BUILD_HINT}`);
  }
  const receiptText = await readFile(receiptSource, "utf8");
  let receipt: Schema.Schema.Type<typeof CliBuildReceipt>;
  try {
    receipt = Schema.decodeUnknownSync(CliBuildReceipt)(JSON.parse(receiptText));
    if (!/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
        !/^[a-f0-9]{64}$/.test(receipt.binary.sha256)) throw new Error("Invalid fingerprint");
  } catch {
    throw new Error(`Isolated Devin requires a committed, all-on CLI build receipt. ${CLI_BUILD_HINT}`);
  }
  try {
    // Test/docs-only commits may follow the build. Product source, build code,
    // dependencies and compiler configuration must still be the same bytes.
    execFileSync("git", ["diff", "--quiet", receipt.sourceCommit, "--",
      "src", "scripts", "package.json", "bun.lock", "tsconfig.json"],
    { cwd: repoRoot, stdio: "pipe" });
  } catch {
    throw new Error(`Isolated Devin CLI source differs from this checkout. ${CLI_BUILD_HINT}`);
  }
  const binary = await readFile(source);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (binary.length !== receipt.binary.bytes || sha256 !== receipt.binary.sha256) {
    throw new Error(`Isolated Devin CLI bytes do not match its build receipt. ${CLI_BUILD_HINT}`);
  }
  const binDir = seededHarnessBinDir(sandbox);
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "vellum-command");
  await writeFile(executable, binary, { mode: 0o755 });
  await chmod(executable, 0o755);
  await writeFile(`${executable}-relink.json`, receiptText);
  return { ...receipt, executable };
};

export const isolatedDevinSenderNode = agentTextNode({
  id: ISOLATED_DEVIN_SENDER_ID,
  key: "local:isolated-sender",
  label: "sender",
  harness: "codex",
  x: 40,
  y: 40,
});

export const isolatedDevinReceiverNode = agentTextNode({
  id: ISOLATED_DEVIN_RECEIVER_ID,
  key: "local:isolated-devin",
  label: "devin",
  harness: "devin",
  x: 360,
  y: 40,
});

export const isolatedDevinMailDoc = (): CanvasDoc => {
  const nodes = [isolatedDevinSenderNode, isolatedDevinReceiverNode];
  return {
    nodes,
    edges: [
      verbEdge(
        "e-sender-devin",
        ISOLATED_DEVIN_SENDER_ID,
        ISOLATED_DEVIN_RECEIVER_ID,
        "messages",
        nodes,
      ),
    ],
  };
};

export const resolveOperatorDevinBinary = (pathEnv: string): string | undefined => {
  const binary = templateFor("devin").argvSpec.binary;
  for (const dir of pathEnv.split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/**
 * afterSeed: fake-tui sender binary + Devin credential seed + symlink to the
 * real `devin` CLI in the sandbox bin (no operator PATH, no history copy).
 */
export const seedIsolatedDevinAppHome = async (
  sandbox: Sandbox,
  operatorHome: string,
  operatorPath: string,
): Promise<ReturnType<typeof prepareIsolatedHarnessLaunch>> => {
  // Refuse before seeding credentials or starting any harness if the actual
  // agent tool is absent or belongs to a different source build.
  await seedIsolatedVellumCli(sandbox);
  const fakeCodex = join(seededHarnessBinDir(sandbox), "codex");
  if (!existsSync(fakeCodex)) {
    await installCrewSeatHarness(sandbox);
  }
  const prepared = prepareIsolatedHarnessLaunch({
    harness: "devin",
    isolatedHome: sandbox.homeDir,
    cwd: join(sandbox.root, "devin-cwd"),
    operatorHome,
  });
  const realDevin = resolveOperatorDevinBinary(operatorPath);
  if (realDevin !== undefined) {
    const binDir = seededHarnessBinDir(sandbox);
    await mkdir(binDir, { recursive: true });
    const dest = join(binDir, "devin");
    if (!existsSync(dest)) symlinkSync(realDevin, dest);
  }
  return prepared;
};
