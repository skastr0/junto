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
  isolatedSpawnRuntimeEnv,
  mailTransportTiers,
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

  it("typed-notice working is support, not live qualification", () => {
    expect(HARNESS_MAIL_TRANSPORT.claude.typedNotice).toBe("working");
    expect(HARNESS_MAIL_TRANSPORT.hermes.typedNotice).toBe("unavailable-setup");
    expect(HARNESS_MAIL_TRANSPORT.kimi.typedNotice).toBe("unavailable-setup");
    expect(HARNESS_MAIL_TRANSPORT.cursor.typedNotice).toBe("unavailable-setup");
    for (const id of HARNESS_IDS) {
      const tiers = mailTransportTiers(HARNESS_MAIL_TRANSPORT[id]);
      expect(tiers.t1NativeChannel, id).toBe(false);
      expect(tiers.t2Qualified, id).toBe(false);
      expect(tiers.t3PullOnly, id).toBe(true);
      expect(tiers.t2Support, id).toBe(HARNESS_MAIL_TRANSPORT[id].typedNotice);
    }
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
      const result = isolatedCaptureEnv({
        harness: id,
        isolatedHome: isolated,
        operatorHome: operator,
        ambient: {
          HOME: operator,
          CLAUDE_CONFIG_DIR: path.join(operator, ".claude"),
          CODEX_HOME: path.join(operator, ".codex"),
          PI_CODING_AGENT_DIR: path.join(operator, ".pi", "agent"),
          SECRET_HISTORY: "must-not-copy",
          OPENAI_API_KEY: "sk-operator",
          ANTHROPIC_API_KEY: "sk-operator",
        },
      });
      if (spec.captureHome === "unsupported") {
        expect(result.ok, id).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.limitation.length, id).toBeGreaterThan(0);
        expect(JSON.stringify(result), id).not.toContain(operator);
        expect("env" in result, id).toBe(false);
        continue;
      }
      expect(result.ok, id).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.env.HOME, id).toBe(isolated);
      expect(result.env.HOME).not.toBe(operator);
      expect(result.env.SECRET_HISTORY).toBeUndefined();
      expect(result.env.OPENAI_API_KEY).toBeUndefined();
      expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(HARNESS_ISOLATION[id].credentialEnv, id).toEqual([]);
      for (const pin of spec.homePins) {
        expect(result.env[pin.envKey], `${id} ${pin.envKey}`).toBe(`${isolated}/${pin.homeRelative}`);
        expect(result.env[pin.envKey]?.startsWith(operator + path.sep) ?? false).toBe(false);
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
      operatorHome: operator,
      ambient: {
        HOME: operator,
        CLAUDE_CONFIG_DIR: path.join(operator, ".claude"),
        SECRET_HISTORY: "must-not-copy",
      },
    });
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error("unreachable");
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
      operatorHome: operator,
      ambient: { HOME: operator },
    });
    expect(overseer.ok).toBe(false);
    if (overseer.ok) throw new Error("unreachable");
    expect(overseer.captureHome).toBe("unsupported");
    expect(overseer.limitation.length).toBeGreaterThan(0);
    expect("env" in overseer).toBe(false);
    expect(JSON.stringify(overseer)).not.toContain(operator);
  });

  it("refuses the operator home as an isolated capture home", () => {
    const operator = os.homedir();
    const refused = isolatedCaptureEnv({
      harness: "codex",
      isolatedHome: operator,
      operatorHome: operator,
      ambient: {
        HOME: operator,
        OPENAI_API_KEY: "sk-operator",
      },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.limitation).toContain("operator home");
    expect("env" in refused).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("sk-operator");
    expect(
      isolatedCaptureEnv({
        harness: "muse",
        isolatedHome: "/tmp/iso",
        operatorHome: "",
      }).ok,
    ).toBe(false);
    expect(
      isolatedCaptureEnv({
        harness: "muse",
        isolatedHome: "",
        operatorHome: operator,
      }).ok,
    ).toBe(false);
    expect(
      isolatedCaptureEnv({
        harness: "muse",
        isolatedHome: "~",
        operatorHome: operator,
      }).ok,
    ).toBe(false);
    const injected = isolatedCaptureEnv({
      harness: "codex",
      isolatedHome: "/tmp/not-a-real-operator",
      operatorHome: "/tmp/not-a-real-operator",
    });
    expect(injected.ok).toBe(false);
  });

  it("does not import node:os in the renderer-shared templates module", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../src/shared/managed-terminal-templates.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']node:os["']/);
    expect(source).not.toMatch(/\bhomedir\s*\(/);
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

  it("isolated spawn env does not inherit operator auth keys", () => {
    const isolated = path.join(os.tmpdir(), "vellum-capture-home-test");
    const previous = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME,
    };
    process.env.ANTHROPIC_API_KEY = "sk-operator-anthropic";
    process.env.OPENAI_API_KEY = "sk-operator-openai";
    process.env.CODEX_HOME = path.join(os.homedir(), ".codex");
    try {
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
      expect(claude.ANTHROPIC_API_KEY).toBeUndefined();
      expect(claude.OPENAI_API_KEY).toBeUndefined();
      expect(claude.CODEX_HOME).toBeUndefined();
      expect(claude.CLAUDE_CONFIG_DIR).toBe(path.join(isolated, ".claude"));
      expect(claude.HOME).toBe(isolated);
      const runtime = isolatedSpawnRuntimeEnv({
        PATH: "/sandbox/bin",
        ANTHROPIC_API_KEY: "sk-operator-anthropic",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        HOME: os.homedir(),
      });
      expect(runtime.PATH).toBe("/sandbox/bin");
      expect(runtime.ANTHROPIC_API_KEY).toBeUndefined();
      expect(runtime.SSH_AUTH_SOCK).toBeUndefined();
      expect(runtime.HOME).toBeUndefined();
    } finally {
      if (previous.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous.ANTHROPIC_API_KEY;
      if (previous.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous.OPENAI_API_KEY;
      if (previous.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.CODEX_HOME;
    }
  });
});

describe("committed capture stream provenance", () => {
  it("does not treat T2 working as a mail-notice corpus", () => {
    const root = path.join(import.meta.dirname, "pty-e2e", "corpus");
    for (const id of HARNESS_IDS) {
      const hasNotice = fs.existsSync(path.join(root, id, "mail-notice.jsonl"));
      const hasPaste = fs.existsSync(path.join(root, id, "paste-chip.jsonl"));
      const hasIdle = fs.existsSync(path.join(root, id, "startup-idle.jsonl"));
      expect(HARNESS_MAIL_TRANSPORT[id].typedNoticeQualified, id).toBe(hasNotice);
      expect(HARNESS_MAIL_TRANSPORT[id].nativeChannel, id).toBe(false);
      if (hasPaste || hasIdle) {
        expect(hasNotice, `${id} corpus is not mail qualification`).toBe(false);
      }
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
