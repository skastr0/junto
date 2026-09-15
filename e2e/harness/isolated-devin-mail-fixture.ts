/**
 * Isolated real-Devin generated-canvas fixture (p16). Disjoint from fake-tui
 * crew-fixture.ts. Adapter seed does not flip typedNoticeQualified.
 */
import { existsSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
