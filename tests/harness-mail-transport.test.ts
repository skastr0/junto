import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_IDS,
  HARNESS_ISOLATION,
  HARNESS_MAIL_TRANSPORT,
  buildIsolatedHarnessLaunch,
  isolatedCaptureEnv,
  templateFor,
} from "../src/shared/managed-terminal-templates";
import { buildSpawnEnv } from "./pty-e2e/pty-capture";

describe("harness mail transport facts", () => {
  it("every harness is pull-only and none claims an unproven native channel", () => {
    for (const id of HARNESS_IDS) {
      const spec = HARNESS_MAIL_TRANSPORT[id];
      expect(spec.pullOnly, id).toBe(true);
      expect(spec.nativeChannel, `${id} must not declare T1 without a proven native delivery channel`).toBe(false);
      expect(["working", "unavailable-setup"]).toContain(spec.typedNotice);
      expect(templateFor(id).mailTransport).toEqual(spec);
    }
  });

  it("typed-notice working is distinct from unavailable setup", () => {
    expect(HARNESS_MAIL_TRANSPORT.claude.typedNotice).toBe("working");
    expect(HARNESS_MAIL_TRANSPORT.hermes.typedNotice).toBe("unavailable-setup");
    expect(HARNESS_MAIL_TRANSPORT.kimi.typedNotice).toBe("unavailable-setup");
    expect(HARNESS_MAIL_TRANSPORT.cursor.typedNotice).toBe("unavailable-setup");
  });

  it("does not mint message metadata keys on the template", () => {
    const spec = HARNESS_MAIL_TRANSPORT.claude as unknown as Record<string, unknown>;
    for (const key of [
      "mailKind",
      "subject",
      "refs",
      "fromSeat",
      "senderGeneration",
      "senderHarness",
      "queuedAt",
      "notifiedAt",
      "deliveredAt",
      "unresolvedAt",
      "refusedAt",
      "refusedReason",
      "refuseReason",
      "readAt",
      "repliedAt",
      "reactedAt",
      "generation",
    ]) {
      expect(spec[key], key).toBeUndefined();
    }
  });
});

describe("isolated capture home", () => {
  it("never points HOME or config pins at the operator home", () => {
    const operator = os.homedir();
    const isolated = path.join(os.tmpdir(), "vellum-capture-home-test");
    for (const id of HARNESS_IDS) {
      const spec = HARNESS_ISOLATION[id];
      const { env } = isolatedCaptureEnv(id, isolated, {
        HOME: operator,
        CLAUDE_CONFIG_DIR: path.join(operator, ".claude"),
        CODEX_HOME: path.join(operator, ".codex"),
        PI_CODING_AGENT_DIR: path.join(operator, ".pi", "agent"),
        SECRET_HISTORY: "must-not-copy",
      });
      expect(env.HOME, id).toBe(isolated);
      expect(env.HOME).not.toBe(operator);
      expect(env.SECRET_HISTORY).toBeUndefined();
      for (const pin of spec.homePins) {
        expect(env[pin.envKey], `${id} ${pin.envKey}`).toBe(`${isolated}/${pin.homeRelative}`);
        expect(env[pin.envKey]?.startsWith(operator + path.sep) ?? false).toBe(false);
      }
    }
  });

  it("buildIsolatedHarnessLaunch is an overlay, never operator HOME or cwd", () => {
    const operator = os.homedir();
    const isolatedHome = path.join(os.tmpdir(), "vellum-isolated-home");
    const cwd = path.join(os.tmpdir(), "vellum-isolated-cwd");
    const launch = buildIsolatedHarnessLaunch({
      harness: "claude",
      isolatedHome,
      cwd,
      ambient: {
        HOME: operator,
        CLAUDE_CONFIG_DIR: path.join(operator, ".claude"),
        SECRET_HISTORY: "must-not-copy",
      },
    });
    expect(launch.harness).toBe("claude");
    expect(launch.captureHome).toBe("isolated");
    expect(launch.isolatedHome).toBe(isolatedHome);
    expect(launch.cwd).toBe(cwd);
    expect(launch.env.HOME).toBe(isolatedHome);
    expect(launch.env.HOME).not.toBe(operator);
    expect(launch.env.PWD).toBe(cwd);
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(`${isolatedHome}/.claude`);
    expect(launch.env.SECRET_HISTORY).toBeUndefined();
    expect(HARNESS_ISOLATION["vellum-overseer"].captureHome).toBe("unsupported");
    const overseer = buildIsolatedHarnessLaunch({
      harness: "vellum-overseer",
      isolatedHome,
      cwd,
    });
    expect(overseer.captureHome).toBe("unsupported");
    expect(overseer.env.HOME).toBe(isolatedHome);
  });

  it("capture spawn overlay relocates Claude and Pi config dirs", () => {
    const isolated = path.join(os.tmpdir(), "vellum-capture-home-test");
    const claude = buildSpawnEnv(
      {
        name: "claude",
        displayName: "Claude Code",
        argv: () => [],
        promptGlyphs: [">"],
        exitRecipe: [],
      },
      isolated,
      isolated,
    );
    expect(claude.HOME).toBe(isolated);
    expect(claude.CLAUDE_CONFIG_DIR).toBe(path.join(isolated, ".claude"));
  });
});

describe("committed capture stream provenance", () => {
  it("does not treat T2 working as a mail-notice corpus", () => {
    const root = path.join(import.meta.dirname, "pty-e2e", "corpus");
    for (const id of HARNESS_IDS) {
      expect(fs.existsSync(path.join(root, id, "mail-notice.jsonl")), id).toBe(false);
      expect(HARNESS_MAIL_TRANSPORT[id].nativeChannel, id).toBe(false);
    }
  });

  it("startup-idle fixtures keep a complete prefix, not an empty tail", () => {
    const root = path.join(import.meta.dirname, "pty-e2e", "corpus");
    const harnesses = fs.readdirSync(root).filter((name) => {
      return fs.existsSync(path.join(root, name, "startup-idle.jsonl"));
    });
    expect(harnesses.length).toBeGreaterThan(0);
    for (const harness of harnesses) {
      const file = path.join(root, harness, "startup-idle.jsonl");
      const events = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      expect(events.length, harness).toBeGreaterThan(0);
      const first = JSON.parse(events[0]!) as { b64?: string };
      const raw = Buffer.from(first.b64 ?? "", "base64");
      expect(raw.length, `${harness} first event`).toBeGreaterThan(32);
      const digest = createHash("sha256").update(raw).digest("hex");
      expect(digest).toHaveLength(64);
    }
  });
});
