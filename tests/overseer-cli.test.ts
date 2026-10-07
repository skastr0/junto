import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import {
  OVERSEER_CATALOG,
  OVERSEER_OPERATION_NAMES,
  OverseerSecretPutInput,
  decodeOverseerArgs,
  decodeOverseerRequest,
} from "../src/shared/overseer-control";
import {
  WORK_HOME_ENV,
  WORK_PROTOCOL_VERSION,
  WORK_TOKEN_ENV,
  decodeWorkRequest,
  workControlSocketPath,
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
      const tier = BUILD_FEATURES[key as FeatureKey];
      env[feature.env] = tier === true ? "1" : tier === false ? "0" : "experimental";
    }
    if (options.home) env.JUNTO_HOME = options.home;
    if (options.workHome) {
      env[WORK_HOME_ENV] = options.workHome;
      env[WORK_TOKEN_ENV] = "overseer-token";
    }
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

  it("marks page.eval, screenshots, and msg.list as mutations per catalog", () => {
    const byOp = Object.fromEntries(OVERSEER_CATALOG.map((entry) => [entry.operation, entry]));
    expect(byOp["page.eval"]?.mutation).toBe(true);
    expect(byOp["page.screenshot"]?.mutation).toBe(true);
    expect(byOp["canvas.screenshot"]?.mutation).toBe(true);
    expect(byOp["msg.list"]?.mutation).toBe(true);
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
      // `secret put` takes its value from stdin, so its example is the
      // command's argument, not the wire args.
      const decoded = operation === "secret.put"
        ? Schema.decodeUnknownResult(OverseerSecretPutInput, { onExcessProperty: "error" })(example.input)
        : decodeOverseerArgs(operation, example.input);
      expect(Result.isSuccess(decoded)).toBe(true);
    }
    for (const entry of OVERSEER_CATALOG.filter(({ family }) => family === "env" || family === "secret")) {
      expect(overseerExamples.some((example) => example.command_id === `overseer.${entry.operation}`)).toBe(true);
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
    expect(docsData.data.content).toContain("junto overseer");

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

// Each test here spawns the source CLI several times.
const SPAWNING_TEST_TIMEOUT_MS = 60_000;

describe("overseer region environment and secrets CLI", { timeout: SPAWNING_TEST_TIMEOUT_MS }, () => {
  const VALUE = "s3cr3t-never-echoed";
  const overseerOk = (operation: string, data: unknown) => ({
    ok: true,
    op: "overseer",
    protocol_version: WORK_PROTOCOL_VERSION,
    data: { ok: true, operation, data },
  });
  const innerOf = (observed: Record<string, unknown> | undefined) =>
    observed?.args as { operation: string; args: Record<string, unknown> } | undefined;

  it("reads the secret value from stdin, strips one newline, and never prints it", async () => {
    let observed: Record<string, unknown> | undefined;
    const { workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return overseerOk("secret.put", { secretId: "minted", stored: true, backend: "file" });
    });
    const minted = await runCli(["overseer", "secret", "put"], { workHome, stdin: `${VALUE}\n` });
    expect(minted.code).toBe(0);
    expect(parseStdout(minted.stdout)).toEqual({
      ok: true,
      command: "overseer secret put",
      data: { secretId: "minted", stored: true, backend: "file" },
    });
    expect(innerOf(observed)).toEqual({ operation: "secret.put", args: { value: VALUE } });

    const named = await runCli(["overseer", "secret", "put", '{"secretId":"5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70"}'], { workHome, stdin: VALUE });
    expect(named.code).toBe(0);
    expect(innerOf(observed)).toEqual({ operation: "secret.put", args: { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70", value: VALUE } });
    expect(`${minted.stdout}${minted.stderr}${named.stdout}${named.stderr}`).not.toContain(VALUE);
  });

  it("refuses a value outside stdin without opening a socket or repeating it", async () => {
    let calls = 0;
    const { workHome } = await startFakeWorkSocket(() => {
      calls += 1;
      return overseerOk("secret.put", {});
    });
    for (const [args, stdin] of [
      [["overseer", "secret", "put", JSON.stringify({ value: VALUE })], "anything"],
      [["overseer", "secret", "put", JSON.stringify({ secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70", value: VALUE })], "anything"],
      [["overseer", "secret", "put", JSON.stringify({ secretId: VALUE })], "anything"],
      [["overseer", "secret", "put", JSON.stringify({ note: VALUE })], "anything"],
      [["overseer", "secret", "put", "-"], JSON.stringify({ secretId: "abc", value: VALUE })],
      [["overseer", "secret", "put"], ""],
      [["overseer", "secret", "put"], "\n"],
    ] as const) {
      const result = await runCli(args, { workHome, stdin });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const parsed = JSON.parse(result.stderr.trim()) as { ok: false; command: string; error: { type: string } };
      expect(parsed.command).toBe("overseer secret put");
      expect(parsed.error.type).toBe("InputError");
      expect(result.stderr).not.toContain(VALUE);
    }
    expect(calls).toBe(0);
  });

  it("documents secret put as taking no value argument", async () => {
    const shown = await runCli(["overseer", "schema", "show", "secret.put"]);
    expect(shown.code).toBe(0);
    const data = (parseStdout(shown.stdout) as {
      data: { input_modes: string[]; schema: { properties?: Record<string, unknown> } };
    }).data;
    expect(Object.keys(data.schema.properties ?? {})).toEqual(["secretId"]);
    const skill = OVERSEER_SKILL_MARKDOWN;
    expect(skill).toContain("read from stdin only");
    expect(skill).toContain("env doctor");
    expect(skill).not.toContain("\u00b7");
  });

  it("prints the doctor report whole and exits non-zero only for a required source that could not be read", async () => {
    const row = (status: string, required: boolean) => ({
      regionId: "box", regionLabel: "Box", sourceId: "token", kind: "keychain",
      names: ["EXAMPLE_AUTH_TOKEN"], status, required,
    });
    const report = (status: string, required: boolean) => ({
      regions: [{ regionId: "box", regionLabel: "Box", sealed: false, sources: [row(status, required)] }],
      seats: [],
    });
    let next: unknown = report("ok", true);
    let observed: Record<string, unknown> | undefined;
    const { workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return overseerOk("env.doctor", next);
    });
    for (const [status, required, code] of [
      ["ok", true, 0],
      ["missing", false, 0],
      ["skipped-host", true, 0],
      ["overridden", true, 0],
      ["missing", true, 1],
      ["error", true, 1],
    ] as const) {
      next = report(status, required);
      const result = await runCli(["overseer", "env", "doctor", '{"nodeId":"box"}'], { workHome });
      expect(result.code).toBe(code);
      expect(parseStdout(result.stdout)).toEqual({ ok: true, command: "overseer env doctor", data: next });
    }
    expect(innerOf(observed)).toEqual({ operation: "env.doctor", args: { nodeId: "box" } });
  });

  it("sends an environment edit as its own operation", async () => {
    let observed: Record<string, unknown> | undefined;
    const { workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return overseerOk("env.source-add", { nodeId: "box", sourceId: "source-1", environment: {} });
    });
    const input = { nodeId: "box", source: { kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "op" } };
    const result = await runCli(["overseer", "env", "source-add", JSON.stringify(input)], { workHome });
    expect(result.code).toBe(0);
    expect(innerOf(observed)).toEqual({ operation: "env.source-add", args: input });
    const refused = await runCli(["overseer", "env", "source-add", '{"nodeId":"box","source":{"kind":"nope"}}'], { workHome });
    expect(refused.code).toBe(1);
    expect((JSON.parse(refused.stderr.trim()) as { error: { type: string } }).error.type).toBe("InputError");
  });

  // The work-socket op belongs to the region environment resolver. Until it
  // is in the Work vocabulary the CLI cannot decode its answer; this test
  // turns itself on the moment it lands.
  const envReportOpLanded = Result.isSuccess(
    decodeWorkRequest({ token: "t", op: "env.report", args: {} }),
  );

  it.skipIf(!envReportOpLanded)("lets a seat read its own report with junto env report", async () => {
    const seat = (status: string) => ({
      nodeId: "seat", title: "Seat", regions: ["box"], folders: [], restartToApply: false,
      report: [{
        regionId: "box", regionLabel: "Box", sourceId: "token", kind: "keychain",
        names: ["EXAMPLE_AUTH_TOKEN"], status, required: true,
      }],
    });
    let next: unknown = seat("ok");
    let observed: Record<string, unknown> | undefined;
    const { workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return { ok: true, op: "env.report", protocol_version: WORK_PROTOCOL_VERSION, data: next };
    });
    const ok = await runCli(["env", "report"], { workHome });
    expect(ok.code).toBe(0);
    expect(parseStdout(ok.stdout)).toEqual({ ok: true, command: "env report", data: next });
    expect(observed).toMatchObject({ op: "env.report", args: {} });
    next = seat("missing");
    const missing = await runCli(["env", "report"], { workHome });
    expect(missing.code).toBe(1);
    expect(parseStdout(missing.stdout)).toEqual({ ok: true, command: "env report", data: next });
  });

  it("registers junto env report as an ordinary command with a schema, an example and a docs entry", async () => {
    expect(allSchemas.map((schema) => schema.command_id)).toContain("env.report");
    expect(allExamples.map((example) => example.command_id)).toContain("env.report");
    expect(commandCapabilities.map((capability) => capability.command_id)).toContain("env.report");
    for (const topic of ["doctrine", "contract"]) {
      const docs = await runCli(["docs", topic]);
      expect(docs.code).toBe(0);
      expect(docs.stdout).toContain("junto env report");
    }
    const help = await runCli(["env", "report", "--help"]);
    expect(help.code).toBe(0);
    expect(`${help.stdout}${help.stderr}`).toContain("--timeout");
  });

  it("prints the offboard result whole and exits non-zero when any seat was refused", async () => {
    const result = (refused: number) => ({
      results: [
        { seatId: "idle", title: "Idle", ok: true, action: "now", outcome: "closed", pastWindow: true },
        ...(refused > 0 ? [{ seatId: "busy", ok: false, code: "working", reason: "This seat is working." }] : []),
      ],
      closed: 1,
      asked: 0,
      refused,
    });
    let next: unknown = result(0);
    let observed: Record<string, unknown> | undefined;
    const { workHome } = await startFakeWorkSocket((request) => {
      observed = request;
      return overseerOk("agent.offboard", next);
    });
    const input = { nodeIds: ["idle", "busy"], action: "now" };
    const clean = await runCli(["overseer", "agent", "offboard", JSON.stringify(input)], { workHome });
    expect(clean.code).toBe(0);
    expect(parseStdout(clean.stdout)).toEqual({ ok: true, command: "overseer agent offboard", data: next });
    expect(innerOf(observed)).toEqual({ operation: "agent.offboard", args: input });

    next = result(1);
    const refused = await runCli(["overseer", "agent", "offboard", JSON.stringify(input)], { workHome });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe("");
    expect(parseStdout(refused.stdout)).toEqual({ ok: true, command: "overseer agent offboard", data: next });

    const bad = await runCli(["overseer", "agent", "offboard", '{"nodeIds":["idle"],"action":"now","mode":"rest"}'], { workHome });
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.stderr.trim()) as { error: { type: string } }).error.type).toBe("InputError");

    for (const operation of ["agent.offboard", "agent.offboard-status", "agent.offboard-rules", "agent.offboard-configure"]) {
      expect(overseerSchemas.some((schema) => schema.command_id === `overseer.${operation}`)).toBe(true);
      expect(overseerExamples.some((example) => example.command_id === `overseer.${operation}`)).toBe(true);
    }
    expect(OVERSEER_SKILL_MARKDOWN).toContain("agent offboard");
  });
});
