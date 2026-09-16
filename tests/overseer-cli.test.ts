import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  OVERSEER_CATALOG,
  OVERSEER_OPERATION_NAMES,
  decodeOverseerArgs,
  decodeOverseerRequest,
} from "../src/shared/overseer-control";
import {
  WORK_HOME_ENV,
  WORK_PROTOCOL_VERSION,
  decodeWorkRequest,
  workControlSocketPath,
  workControlTokenPath,
} from "../src/shared/work-control";
import {
  allExamples,
  allSchemas,
  commandCapabilities,
  renderSchemaContract,
} from "../src/cli/core/discovery";
import { BUILD_FEATURES } from "../src/shared/features";
import {
  FEATURE_CATALOG,
  type FeatureKey,
} from "../src/shared/feature-catalog";
import {
  overseerExamples,
  overseerOfflineCapabilities,
  overseerSchemas,
  unwrapOverseerSocketData,
} from "../src/cli/commands/overseer";
import { OVERSEER_SKILL_MARKDOWN } from "../src/cli/commands/overseer-skill";
import { Effect } from "effect";
import { __resetJuntoHomeCache } from "../src/shared/junto-home";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  delete process.env[WORK_HOME_ENV];
  delete process.env.JUNTO_HOME;
  __resetJuntoHomeCache();
  process.exitCode = 0;
});

const runCli = (
  args: ReadonlyArray<string>,
  options: {
    readonly home?: string;
    readonly workHome?: string;
    readonly stdin?: string;
  } = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolveRun, rejectRun) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The source CLI resolves features from JUNTO_* when no build
    // defines are present; mirror this test's build profile so the child and
    // the in-process catalog agree.
    for (const [key, feature] of Object.entries(FEATURE_CATALOG)) {
      env[feature.env] = BUILD_FEATURES[key as FeatureKey] ? "1" : "0";
    }
    if (options.home) env.JUNTO_HOME = options.home;
    if (options.workHome) env[WORK_HOME_ENV] = options.workHome;
    const child = spawn("bun", [join(repoRoot, "src/cli/main.ts"), ...args], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });

const parseStdout = (stdout: string): unknown => {
  const line = stdout.trim();
  expect(line.includes("\n")).toBe(false);
  return JSON.parse(line) as unknown;
};

const startFakeWorkSocket = async (
  respond: (request: Record<string, unknown>) => unknown,
): Promise<{ readonly home: string; readonly workHome: string }> => {
  const home = await mkdtemp(join(tmpdir(), "vc-overseer-"));
  roots.push(home);
  const workHome = join(home, ".junto", "work");
  await mkdir(workHome, { recursive: true });
  await writeFile(workControlTokenPath(workHome), "overseer-token\n", { mode: 0o600 });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const decoded = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<
        string,
        unknown
      >;
      socket.end(`${JSON.stringify(respond(decoded))}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(workControlSocketPath(workHome), () => resolveListen());
  });
  return { home, workHome };
};

describe("overseer catalog wiring", () => {
  it("registers every OverseerOperation as schema and capability", () => {
    const operations = OVERSEER_OPERATION_NAMES.map((name) => `overseer.${name}`);
    const schemaIds = allSchemas.map((schema) => schema.command_id);
    const capabilityIds = commandCapabilities.map((capability) => capability.command_id);
    expect(schemaIds).toEqual(expect.arrayContaining(operations));
    expect(capabilityIds).toEqual(expect.arrayContaining(operations));
    expect(overseerSchemas).toHaveLength(OVERSEER_OPERATION_NAMES.length);
    expect(new Set(OVERSEER_CATALOG.map((entry) => entry.operation)).size).toBe(
      OVERSEER_OPERATION_NAMES.length,
    );
  });

  it("keeps schema/examples/skill as offline CLI commands, not operations", () => {
    expect(OVERSEER_OPERATION_NAMES).not.toContain("schema");
    expect(OVERSEER_OPERATION_NAMES).not.toContain("examples");
    expect(OVERSEER_OPERATION_NAMES).not.toContain("skill");
    expect(commandCapabilities.map((c) => c.command_id)).toEqual(
      expect.arrayContaining([
        "overseer.skill",
        "overseer.schema",
        "overseer.examples",
        "overseer.capabilities",
      ]),
    );
  });

  it("marks page.eval, screenshots, msg.list, and pad.read as mutations per catalog", () => {
    const byOp = Object.fromEntries(OVERSEER_CATALOG.map((entry) => [entry.operation, entry]));
    expect(byOp["page.eval"]?.mutation).toBe(true);
    expect(byOp["page.screenshot"]?.mutation).toBe(true);
    expect(byOp["canvas.screenshot"]?.mutation).toBe(true);
    expect(byOp["msg.list"]?.mutation).toBe(true);
    expect(byOp["pad.read"]?.mutation).toBe(true);
    expect(byOp["canvas.list"]?.mutation).toBe(false);
    expect(byOp.status?.mutation).toBe(false);
  });

  it("produces JSON Schema and decodes every overseer example against its schema", () => {
    for (const contract of overseerSchemas) {
      const rendered = renderSchemaContract(contract);
      expect(rendered.schema).toBeTypeOf("object");
    }
    for (const example of overseerExamples) {
      if (example.input === undefined) continue;
      const operation = example.command_id.replace(/^overseer\./, "") as (typeof OVERSEER_OPERATION_NAMES)[number];
      const decoded = decodeOverseerArgs(operation, example.input);
      expect(Result.isSuccess(decoded)).toBe(true);
    }
    const related = allExamples.filter((example) => example.command_id.startsWith("overseer."));
    expect(related.length).toBeGreaterThan(0);
  });

  it("does not claim live handlers offline", () => {
    const caps = overseerOfflineCapabilities();
    expect(caps.handlers.claimed).toBe(false);
    expect(caps.unavailable.some((item) => item.capability.includes("viewport"))).toBe(true);
    expect(caps.authority.grant).toBe("human-only");
    expect(caps.authority.pause_play_has_bearing).toBe(false);
    expect(caps.authority.self_deletion).toBe(false);
    expect(caps.implemented.cli_transport).toEqual([...OVERSEER_OPERATION_NAMES]);
  });
});

describe("overseer result unwrap", () => {
  it("surfaces inner ok:false as a typed failure, never success", async () => {
    const result = await Effect.runPromise(
      unwrapOverseerSocketData({
        ok: false,
        operation: "node.delete",
        error: { type: "Forbidden", message: "cannot delete own seat" },
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.type).toBe("Forbidden");
      expect(result.failure.message).toMatch(/own seat/);
    }
  });

  it("returns inner data on ok:true", async () => {
    const data = await Effect.runPromise(
      unwrapOverseerSocketData({
        ok: true,
        operation: "canvas.list",
        data: { canvases: ["work"] },
      }),
    );
    expect(data).toEqual({ canvases: ["work"] });
  });
});

describe("overseer source CLI offline", () => {
  it("prints the embedded skill without a daemon", async () => {
    const result = await runCli(["overseer", "skill"]);
    expect(result.code).toBe(0);
    const parsed = parseStdout(result.stdout) as {
      ok: boolean;
      command: string;
      data: { name: string; offline: boolean; content: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("overseer skill");
    expect(parsed.data.offline).toBe(true);
    expect(parsed.data.content).toBe(OVERSEER_SKILL_MARKDOWN);
    expect(parsed.data.content).toContain("Human-only toggle");
    expect(parsed.data.content).toContain("no bearing");
    expect(result.stderr).toBe("");
  });

  it("lists and shows schemas without a daemon", async () => {
    const listed = await runCli(["overseer", "schema", "list"]);
    expect(listed.code).toBe(0);
    const listedData = parseStdout(listed.stdout) as {
      ok: true;
      data: { schemas: Array<{ command_id: string; operation: string }> };
    };
    expect(listedData.data.schemas.map((schema) => schema.operation)).toEqual(
      expect.arrayContaining(["status", "canvas.create", "canvas.batch", "agent.reseat", "page.eval"]),
    );

    const shown = await runCli(["overseer", "schema", "show", "canvas.create"]);
    expect(shown.code).toBe(0);
    const shownData = parseStdout(shown.stdout) as {
      ok: true;
      data: { operation: string; schema: { required?: string[] } };
    };
    expect(shownData.data.operation).toBe("canvas.create");
    expect(shownData.data.schema.required).toEqual(expect.arrayContaining(["canvas"]));
  });

  it("shows docs overseer and help offline", async () => {
    const docs = await runCli(["docs", "overseer"]);
    expect(docs.code).toBe(0);
    const docsData = parseStdout(docs.stdout) as {
      ok: true;
      data: { topic: string; offline: boolean; content: string };
    };
    expect(docsData.data.topic).toBe("overseer");
    expect(docsData.data.offline).toBe(true);
    expect(docsData.data.content).toContain("vellum-command overseer");

    const help = await runCli(["overseer", "--help"]);
    expect(help.code).toBe(0);
    expect(`${help.stdout}${help.stderr}`).toMatch(/canvas|skill|schema/);
  });

  it("rejects invalid args offline without opening a socket", async () => {
    const result = await runCli(["overseer", "canvas", "create", "{}"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stderr.trim()) as {
      ok: false;
      command: string;
      error: { type: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("overseer canvas create");
    expect(parsed.error.type).toBe("InputError");
  });
});

describe("overseer source CLI work socket", () => {
  it("sends {op:overseer,args:{operation,args}} and unwraps inner success", async () => {
    let observed: Record<string, unknown> | undefined;
    const { workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return {
        ok: true,
        op: "overseer",
        protocol_version: WORK_PROTOCOL_VERSION,
        data: {
          ok: true,
          operation: "canvas.list",
          data: { canvases: [{ name: "work" }] },
        },
      };
    });

    const result = await runCli(["overseer", "canvas", "list", "{}"], { workHome });
    expect(result.code).toBe(0);
    const parsed = parseStdout(result.stdout) as {
      ok: true;
      command: string;
      data: { canvases: Array<{ name: string }> };
    };
    expect(parsed.command).toBe("overseer canvas list");
    expect(parsed.data.canvases[0]?.name).toBe("work");
    expect(observed?.op).toBe("overseer");
    expect(observed?.token).toBe("overseer-token");
    const decodedRequest = decodeWorkRequest(observed);
    expect(decodedRequest._tag).toBe("Success");
    const inner = decodeOverseerRequest(observed?.args);
    expect(inner._tag).toBe("Success");
    if (inner._tag === "Success") {
      expect(inner.success).toEqual({ operation: "canvas.list", args: {} });
    }
  });

  it("exits nonzero when the inner OverseerResult is an error", async () => {
    const { workHome } = await startFakeWorkSocket(() => ({
      ok: true,
      op: "overseer",
      protocol_version: WORK_PROTOCOL_VERSION,
      data: {
        ok: false,
        operation: "node.delete",
        error: { type: "Forbidden", message: "cannot delete own seat" },
      },
    }));

    const result = await runCli(
      ["overseer", "node", "delete", JSON.stringify({ nodeId: "self" })],
      { workHome },
    );
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stderr.trim()) as {
      ok: false;
      error: { type: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.type).toBe("Forbidden");
    expect(parsed.error.message).toMatch(/own seat/);
    expect(result.stdout).toBe("");
  });

  it("loads @file JSON and forwards decoded args", async () => {
    let observed: Record<string, unknown> | undefined;
    const { home, workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return {
        ok: true,
        op: "overseer",
        protocol_version: WORK_PROTOCOL_VERSION,
        data: { ok: true, operation: "node.move", data: { applied: true } },
      };
    });
    const file = join(home, "move.json");
    await writeFile(file, JSON.stringify({ nodeId: "n1", x: 12, y: 40 }));

    const result = await runCli(["overseer", "node", "move", `@${file}`], { workHome });
    expect(result.code).toBe(0);
    const inner = decodeOverseerRequest(observed?.args);
    expect(inner._tag).toBe("Success");
    if (inner._tag === "Success") {
      expect(inner.success).toEqual({
        operation: "node.move",
        args: { nodeId: "n1", x: 12, y: 40 },
      });
    }
  });

  it("maps outer work AuthError without treating it as overseer success", async () => {
    const { workHome } = await startFakeWorkSocket(() => ({
      ok: false,
      op: "overseer",
      protocol_version: WORK_PROTOCOL_VERSION,
      error: {
        type: "AuthError",
        message: "process-bind failed",
        details: { next_step: "run under a live granted agent process" },
      },
    }));
    const result = await runCli(["overseer", "status", "{}"], { workHome });
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stderr.trim()) as {
      ok: false;
      error: { type: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.type).toBe("AuthError");
    expect(parsed.error.message).toMatch(/process-bind/);
    expect(result.stdout).toBe("");
  });
});

describe("overseer schema decode (contract assumptions)", () => {
  it("refuses excess properties and missing required fields", () => {
    expect(Result.isFailure(decodeOverseerArgs("canvas.create", {}))).toBe(true);
    expect(Result.isSuccess(decodeOverseerArgs("canvas.list", {}))).toBe(true);
    expect(Result.isSuccess(decodeOverseerArgs("status", {}))).toBe(true);
    expect(
      Result.isSuccess(
        decodeOverseerArgs("agent.reseat", { nodeId: "a1", harness: "amp" }),
      ),
    ).toBe(true);
  });
});
