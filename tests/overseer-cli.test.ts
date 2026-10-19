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
      ["overseer", "node", "delete", JSON.stringify({ nodeIds: ["self"] })],
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

  it("sends nodes and wires in model kinds, and refuses a document shape before the socket", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { workHome } = await startFakeWorkSocket((request) => {
      observed.push(request);
      return overseerOk((request.args as { operation: string }).operation, {});
    });
    const sent: ReadonlyArray<readonly [ReadonlyArray<string>, string, unknown]> = [
      [["overseer", "node", "create", '{"node":{"kind":"note","text":"hi","x":0,"y":0,"width":200,"height":80}}'], "node.create",
        { node: { kind: "note", text: "hi", x: 0, y: 0, width: 200, height: 80 } }],
      [["overseer", "node", "configure", '{"nodeId":"r1","change":{"kind":"region","label":"CLI","instruction":null}}'], "node.configure",
        { nodeId: "r1", change: { kind: "region", label: "CLI", instruction: null } }],
      [["overseer", "node", "recolor", '{"nodeIds":["n1","n2"],"color":null}'], "node.recolor", { nodeIds: ["n1", "n2"], color: null }],
      [["overseer", "node", "delete", '{"nodeIds":["n1"]}'], "node.delete", { nodeIds: ["n1"] }],
      [["overseer", "wire", "connect", '{"wire":{"from":"a","to":"b"}}'], "wire.connect", { wire: { from: "a", to: "b" } }],
      [["overseer", "wire", "configure", '{"wireId":"w1","change":{"verb":"reviews","mask":null}}'], "wire.configure",
        { wireId: "w1", change: { verb: "reviews", mask: null } }],
      [["overseer", "wire", "list"], "wire.list", {}],
      [["overseer", "node", "create", '{"node":{"kind":"agent","harness":"claude","model":"opus","x":0,"y":0,"width":260,"height":120}}'], "node.create",
        { node: { kind: "agent", harness: "claude", model: "opus", x: 0, y: 0, width: 260, height: 120 } }],
      [["overseer", "agent", "reseat", '{"nodeId":"a1","harness":"codex","effort":"high"}'], "agent.reseat",
        { nodeId: "a1", harness: "codex", effort: "high" }],
      [["overseer", "canvas", "batch", '{"expectedSeq":7,"steps":[{"operation":"wire.disconnect","wireId":"w1"}]}'], "canvas.batch",
        { expectedSeq: 7, steps: [{ operation: "wire.disconnect", wireId: "w1" }] }],
    ];
    for (const [args, operation, expected] of sent) {
      const result = await runCli(args, { workHome });
      expect(result.code).toBe(0);
      expect(innerOf(observed.at(-1))).toEqual({ operation, args: expected });
    }
    const count = observed.length;
    for (const [args, operation] of [
      [["overseer", "node", "create", '{"node":{"type":"text","text":"hi","x":0,"y":0,"width":200,"height":80}}'], "node.create"],
      [["overseer", "node", "create", '{"node":{"kind":"note","text":"hi","x":0,"y":0,"width":200,"height":80,"ether":{}}}'], "node.create"],
      [["overseer", "node", "configure", '{"nodeId":"n1","changes":{"text":"old"}}'], "node.configure"],
      [["overseer", "node", "delete", '{"nodeId":"n1"}'], "node.delete"],
      // A seat is never given a command line, an identity or the grant.
      [["overseer", "node", "create", '{"node":{"kind":"agent","harness":"claude","launch":{"kind":"harness","argv":["claude"]},"x":0,"y":0,"width":260,"height":120}}'], "node.create"],
      [["overseer", "node", "create", '{"node":{"kind":"agent","harness":"claude","agentKey":"local:claude","x":0,"y":0,"width":260,"height":120}}'], "node.create"],
      [["overseer", "node", "create", '{"node":{"kind":"agent","harness":"claude","overseer":true,"x":0,"y":0,"width":260,"height":120}}'], "node.create"],
      [["overseer", "agent", "reseat", '{"nodeId":"a1","harness":"codex","launch":{"kind":"harness","argv":["codex"]}}'], "agent.reseat"],
      [["overseer", "agent", "reseat", '{"nodeId":"a1","agentKey":"local:codex","harness":"codex","host":"local"}'], "agent.reseat"],
      [["overseer", "wire", "connect", '{"edge":{"fromNode":"a","toNode":"b","verb":"messages"}}'], "wire.connect"],
      [["overseer", "wire", "connect", '{"wire":{"fromNode":"a","toNode":"b"}}'], "wire.connect"],
      [["overseer", "canvas", "batch", '{"expectedRevision":"7","operations":[{"operation":"node.move","nodeId":"n1","x":1,"y":2}]}'], "canvas.batch"],
      [["overseer", "canvas", "batch", '{"expectedSeq":"7","steps":[{"operation":"node.move","nodeId":"n1","x":1,"y":2}]}'], "canvas.batch"],
    ] as const) {
      const refused = await runCli(args, { workHome });
      expect(refused.code).toBe(1);
      const error = (JSON.parse(refused.stderr.trim()) as { error: { type: string; details?: { hint?: string } } }).error;
      expect(error.type).toBe("InputError");
      // The hint is the command that prints the shape now taken.
      expect(error.details?.hint).toBe(`junto overseer schema show ${operation}`);
    }
    expect(observed).toHaveLength(count);
  });

  it("says what a seat is made from when a draft or a reseat carries what main works out", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { workHome } = await startFakeWorkSocket((request) => {
      observed.push(request);
      return overseerOk((request.args as { operation: string }).operation, {});
    });
    const count = observed.length;
    for (const [args, fields] of [
      [["overseer", "node", "create", '{"node":{"kind":"agent","harness":"claude","launch":{"kind":"harness","argv":["claude"]},"x":0,"y":0,"width":260,"height":120}}'], ["launch"]],
      [["overseer", "node", "create", '{"node":{"kind":"agent","harness":"claude","overseer":true,"agentKey":"local:claude","x":0,"y":0,"width":260,"height":120}}'], ["agentKey", "overseer"]],
      [["overseer", "agent", "reseat", '{"nodeId":"a1","harness":"codex","launch":{"kind":"harness","argv":["codex"]}}'], ["launch"]],
      [["overseer", "canvas", "batch", '{"steps":[{"operation":"node.create","node":{"kind":"agent","harness":"claude","sessionId":"s","x":0,"y":0,"width":260,"height":120}}]}'], ["sessionId"]],
    ] as const) {
      const refused = await runCli(args, { workHome });
      expect(refused.code).toBe(1);
      const error = (JSON.parse(refused.stderr.trim()) as { error: { type: string; message: string } }).error;
      expect(error.type).toBe("InputError");
      expect(error.message).toContain("A seat is created from harness, profile, model, effort, mode, permissionMode and cwd");
      expect(error.message).toContain("Junto builds its launch");
      expect(error.message).toContain(`Remove: ${fields.join(", ")}`);
    }
    // A terminal keeps its command line: nothing of this applies to it.
    const terminal = await runCli(["overseer", "node", "create", '{"node":{"kind":"terminal","launch":{"kind":"command","argv":["htop"]},"x":0,"y":0,"width":260,"height":120}}'], { workHome });
    expect(terminal.stderr).not.toContain("A seat is created from");
    expect(observed.length).toBeLessThanOrEqual(count + 1);
  });

  it("says in one line that the edge family is now wire, and runs nothing", async () => {
    const observed: unknown[] = [];
    const { workHome } = await startFakeWorkSocket((request) => {
      observed.push(request);
      return overseerOk("status", {});
    });
    for (const verb of ["list", "get", "verbs", "connect", "configure", "disconnect"]) {
      const result = await runCli(["overseer", "edge", verb, '{"edge":{"fromNode":"a","toNode":"b"}}'], { workHome });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().includes("\n")).toBe(false);
      expect((JSON.parse(result.stderr.trim()) as { error: unknown }).error).toMatchObject({
        type: "InputError",
        message: `edge.${verb} is now wire.${verb}: the edge family is now wire`,
        details: { hint: `junto overseer schema show wire.${verb}` },
      });
    }
    const bare = await runCli(["overseer", "edge"], { workHome });
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("the edge family is now wire");
    for (const target of ["edge.connect", "overseer.edge.connect", "overseer edge connect"]) {
      const shown = await runCli(["overseer", "schema", "show", target]);
      expect(shown.code).toBe(1);
      expect(shown.stderr).toContain("edge.connect is now wire.connect");
    }
    // The retired names are nowhere an agent lists or copies from.
    const listed = [
      ...allSchemas.map((schema) => schema.command_id),
      ...allExamples.map((example) => example.command_id),
      ...commandCapabilities.map((capability) => capability.command_id),
    ];
    expect(listed.filter((id) => id.startsWith("overseer.edge."))).toEqual([]);
    expect(JSON.stringify(overseerExamples)).not.toMatch(/fromNode|toNode|edgeId|"ether"|expectedRevision|"type":"text"/u);
    expect(OVERSEER_SKILL_MARKDOWN).toContain("The connection family is `wire`");
    expect(OVERSEER_SKILL_MARKDOWN).toContain("A seat is created by naming what it runs, never by a command line");
    // No example sends a seat a command line, an identity or the grant.
    const seatInputs = overseerExamples
      .filter((example) => /agent\.reseat|node\.create/u.test(example.command_id))
      .map((example) => example.input);
    expect(JSON.stringify(seatInputs)).not.toMatch(/argv|agentKey|bindingId|sessionId|overseer|launch/u);
    for (const field of ["agentKey", "bindingId", "launch", "sessionId", "overseer"]) {
      expect(OVERSEER_SKILL_MARKDOWN).toContain(`\`${field}\``);
    }
    expect(OVERSEER_SKILL_MARKDOWN).not.toMatch(/ether\.|edge connect|expectedRevision` from/u);
    const help = await runCli(["overseer", "--help"]);
    expect(`${help.stdout}${help.stderr}`).toMatch(/\bwire\b/u);
    expect(`${help.stdout}${help.stderr}`).not.toMatch(/^\s*edge\b/mu);
    expect(observed).toEqual([]);
  });

  it("prints for node create exactly the kinds main decodes", async () => {
    const shown = await runCli(["overseer", "schema", "show", "node.create"]);
    expect(shown.code).toBe(0);
    for (const kind of ["agent", "terminal", "page", "task", "requests", "artifacts", "board", "pad", "sheet", "cron", "relay", "watcher", "note", "label", "file", "link", "git", "region"]) {
      expect(shown.stdout).toContain(`"${kind}"`);
    }
    expect(shown.stdout).not.toContain("ether");
    const batch = await runCli(["overseer", "schema", "show", "canvas.batch"]);
    expect(batch.stdout).toContain("expectedSeq");
    expect(batch.stdout).not.toContain("expectedRevision");
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

  it("takes a write's prose from --body as text, a file or stdin, and keeps the argument small", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { home, workHome } = await startFakeWorkSocket((request) => {
      observed.push(request);
      const { operation } = request.args as { operation: string };
      return overseerOk(operation, { written: true });
    });
    const prose = "# Style\n\nSay \"plain\" things.\nBackslash \\ and {braces} stay as typed.\n";
    const file = join(home, "style.md");
    await writeFile(file, prose);

    const fromFile = await runCli(
      ["overseer", "references", "write", '{"name":"style","description":"How we write"}', "--body", `@${file}`],
      { workHome },
    );
    expect(fromFile.code).toBe(0);
    expect(parseStdout(fromFile.stdout)).toEqual({ ok: true, command: "overseer references write", data: { written: true } });
    expect(innerOf(observed.at(-1))).toEqual({
      operation: "references.write",
      args: { name: "style", description: "How we write", body: prose },
    });

    const fromStdin = await runCli(
      ["overseer", "references", "write", '{"name":"runbook","regionId":"region-1"}', "--body", "-"],
      { workHome, stdin: prose },
    );
    expect(fromStdin.code).toBe(0);
    expect(innerOf(observed.at(-1))).toEqual({
      operation: "references.write",
      args: { name: "runbook", regionId: "region-1", body: prose },
    });

    const inline = await runCli(["overseer", "briefing", "write", "--body", "Commit by explicit path."], { workHome });
    expect(inline.code).toBe(0);
    expect(innerOf(observed.at(-1))).toEqual({ operation: "briefing.write", args: { body: "Commit by explicit path." } });

    const jsonOnly = await runCli(["overseer", "references", "write", '{"name":"style","body":"In the argument."}'], { workHome });
    expect(jsonOnly.code).toBe(0);
    expect(innerOf(observed.at(-1))).toEqual({ operation: "references.write", args: { name: "style", body: "In the argument." } });

    const sent = observed.length;
    const refusals: ReadonlyArray<readonly [ReadonlyArray<string>, string, string?]> = [
      [["overseer", "references", "write", '{"name":"style","body":"a"}', "--body", "b"], "given twice"],
      [["overseer", "references", "write", '{"name":"style"}'], "needs a body"],
      [["overseer", "references", "write", '{"name":"style"}', "--body", "  "], "junto overseer references delete"],
      [["overseer", "references", "write", '{"name":"style","body":""}'], "junto overseer references delete"],
      [["overseer", "briefing", "write", "--body", "-"], "needs a body", ""],
      [["overseer", "references", "write", "-", "--body", "-"], "not both", '{"name":"style"}'],
      [["overseer", "references", "write", "{}", "--body", "text"], "name"],
      [["overseer", "references", "write", '{"name":"style","nope":1}', "--body", "text"], "nope"],
    ];
    for (const [args, expected, stdin] of refusals) {
      const refused = await runCli(args, { workHome, ...(stdin === undefined ? {} : { stdin }) });
      expect(refused.code).toBe(1);
      const error = (JSON.parse(refused.stderr.trim()) as { error: { type: string; message: string } }).error;
      expect(error.type).toBe("InputError");
      expect(JSON.stringify(error)).toContain(expected);
    }
    // A refused write never reaches the socket.
    expect(observed).toHaveLength(sent);
  });

  it("sends the other references and briefing commands as their own operations", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { workHome } = await startFakeWorkSocket((request) => {
      observed.push(request);
      return overseerOk((request.args as { operation: string }).operation, {});
    });
    for (const [args, operation, sent] of [
      [["overseer", "references", "list"], "references.list", {}],
      [["overseer", "references", "list", '{"canvas":"factory","regionId":"region-1"}'], "references.list", { canvas: "factory", regionId: "region-1" }],
      [["overseer", "references", "read", '{"name":"style"}'], "references.read", { name: "style" }],
      [["overseer", "references", "delete", '{"name":"style","regionId":"region-1"}'], "references.delete", { name: "style", regionId: "region-1" }],
      [["overseer", "briefing", "read"], "briefing.read", {}],
    ] as const) {
      const result = await runCli(args, { workHome });
      expect(result.code).toBe(0);
      expect(innerOf(observed.at(-1))).toEqual({ operation, args: sent });
    }
    for (const operation of ["references.list", "references.read", "references.write", "references.delete", "briefing.read", "briefing.write"]) {
      expect(overseerExamples.some((example) => example.command_id === `overseer.${operation}`)).toBe(true);
    }
    expect(OVERSEER_SKILL_MARKDOWN).toContain("references write");
    expect(OVERSEER_SKILL_MARKDOWN).toContain("briefing write --body");
    const help = await runCli(["overseer", "references", "write", "--help"]);
    expect(`${help.stdout}${help.stderr}`).toContain("--body");
  });

  it("lists and reads references as ordinary commands, the name a plain argument", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const listing = { references: [{ name: "style", scope: "app", read: "junto references read style", bytes: 10, updatedAt: 1 }] };
    const reference = { name: "style", scope: "app", body: "App style.", updatedAt: 1 };
    const { workHome } = await startFakeWorkSocket((request) => {
      observed.push(request);
      if (request.op === "references.list") {
        return { ok: true, op: "references.list", protocol_version: WORK_PROTOCOL_VERSION, data: listing };
      }
      const { name } = request.args as { name: string };
      return name === "style"
        ? { ok: true, op: "references.read", protocol_version: WORK_PROTOCOL_VERSION, data: reference }
        : {
            ok: false,
            op: "references.read",
            protocol_version: WORK_PROTOCOL_VERSION,
            error: { type: "UnknownTarget", message: `no reference named "${name}"`, details: { hint: "in scope: style" } },
          };
    });
    const listed = await runCli(["references", "list"], { workHome });
    expect(listed.code).toBe(0);
    expect(parseStdout(listed.stdout)).toEqual({ ok: true, command: "references list", data: listing });
    const read = await runCli(["references", "read", "style"], { workHome });
    expect(read.code).toBe(0);
    expect(parseStdout(read.stdout)).toEqual({ ok: true, command: "references read", data: reference });
    const missing = await runCli(["references", "read", "nope"], { workHome });
    expect(missing.code).toBe(1);
    expect((JSON.parse(missing.stderr.trim()) as { error: unknown }).error).toMatchObject({
      type: "UnknownTarget",
      details: { hint: "in scope: style" },
    });
    expect(observed.map(({ op, args }) => ({ op, args }))).toEqual([
      { op: "references.list", args: {} },
      { op: "references.read", args: { name: "style" } },
      { op: "references.read", args: { name: "nope" } },
    ]);
    for (const request of observed) expect(Result.isSuccess(decodeWorkRequest(request))).toBe(true);
  });

  it("registers junto references with schemas, examples and a docs entry", async () => {
    for (const id of ["references.list", "references.read"]) {
      expect(allSchemas.map((schema) => schema.command_id)).toContain(id);
      expect(allExamples.map((example) => example.command_id)).toContain(id);
      expect(commandCapabilities.map((capability) => capability.command_id)).toContain(id);
    }
    for (const topic of ["doctrine", "contract"]) {
      const docs = await runCli(["docs", topic]);
      expect(docs.code).toBe(0);
      expect(docs.stdout).toContain("junto references read");
    }
    const help = await runCli(["references", "read", "--help"]);
    expect(help.code).toBe(0);
    expect(`${help.stdout}${help.stderr}`).toContain("--timeout");
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
