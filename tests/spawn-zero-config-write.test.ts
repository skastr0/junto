import { describe, expect, it } from "vitest";
import { resolveManagedLaunchPlan } from "../src/shared/managed-terminal-launch";
import {
  SPAWN_ENV_SCRUB,
  templateFor,
  type HarnessId,
} from "../src/shared/managed-terminal-templates";
import { buildSpawnEnv, scrubSpawnEnv } from "../src/main/vellum-command/term/templates/resolve-launch";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Beta checklist §11.2: spawn path must not write user harness configs.
 * Resolve + env scrub only produce argv/env — no fs writes under ~/.claude etc.
 */
describe("zero-config-write spawn audit", () => {
  const harnesses: HarnessId[] = [
    "claude",
    "codex",
    "grok",
    "hermes",
    "pi",
    "prime-agent",
    "kimi",
    "muse",
    "devin",
    "cursor",
    "agy",
  ];

  it("every harness spawn scrub strips nested Claude markers", () => {
    const ambient = {
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      NO_COLOR: "1",
      PATH: "/usr/bin",
      HOME: "/tmp/home",
    };
    for (const h of harnesses) {
      const plan = resolveManagedLaunchPlan(h, {
        injection: { seatBound: true, connected: true },
        model: "m",
      }, ambient);
      const env = plan.launch.env ?? {};
      for (const key of SPAWN_ENV_SCRUB) {
        expect(env[key], `${h} still has ${key}`).toBeUndefined();
      }
      // Scrub helper itself
      const scrubbed = scrubSpawnEnv(ambient);
      for (const key of SPAWN_ENV_SCRUB) {
        expect(scrubbed[key]).toBeUndefined();
      }
    }
  });

  it("spawn resolve never creates paths under harness homes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-spawn-audit-"));
    const homes = {
      claude: path.join(tmp, ".claude"),
      codex: path.join(tmp, ".codex"),
      grok: path.join(tmp, ".grok"),
      hermes: path.join(tmp, ".hermes"),
      pi: path.join(tmp, ".pi"),
      "prime-agent": path.join(tmp, ".prime"),
      kimi: path.join(tmp, ".kimi-code"),
      muse: path.join(tmp, ".config", "muse"),
      devin: path.join(tmp, ".config", "devin"),
      cursor: path.join(tmp, ".cursor"),
      agy: path.join(tmp, ".gemini"),
    };
    for (const p of Object.values(homes)) fs.mkdirSync(p, { recursive: true });
    const before = new Map(
      Object.entries(homes).map(([k, p]) => [
        k,
        fs.readdirSync(p, { withFileTypes: true }).map((d) => d.name).sort(),
      ]),
    );

    for (const h of harnesses) {
      resolveManagedLaunchPlan(
        h,
        {
          injection: { seatBound: true, connected: true },
          sessionId: "11111111-1111-1111-1111-111111111111",
          cwd: tmp,
        },
        { HOME: tmp, PATH: "/usr/bin" },
      );
      buildSpawnEnv(
        { HOME: tmp, CLAUDE_CODE_CHILD_SESSION: "1", PATH: "/usr/bin" },
        { VELLUM_COMMAND_SOCKET: path.join(tmp, "sock") },
      );
    }

    for (const [k, p] of Object.entries(homes)) {
      const after = fs
        .readdirSync(p, { withFileTypes: true })
        .map((d) => d.name)
        .sort();
      expect(after, `${k} home mutated`).toEqual(before.get(k));
    }
    // templates declare no config-write injection
    for (const h of harnesses) {
      expect(templateFor(h).injectionSpec.tier === "A" || templateFor(h).injectionSpec.tier === "B").toBe(true);
    }
  });
});
