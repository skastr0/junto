import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { WORK_HOME_ENV, WORK_PROTOCOL_VERSION, WORK_TOKEN_ENV, workControlSocketPath } from "../src/shared/work-control";
import { allExamples, allSchemas, commandCapabilities } from "../src/cli/core/discovery";
import { artifactExamples, artifactSchemas } from "../src/cli/commands/artifact";
import { ARTIFACT_OPS } from "../src/shared/artifact-control";
import { ARTIFACTS_ENABLED } from "../src/shared/features";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const runCli = (args: ReadonlyArray<string>, workHome: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("bun", [join(repoRoot, "src/cli/main.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, [WORK_HOME_ENV]: workHome, [WORK_TOKEN_ENV]: "seat-token", JUNTO_ARTIFACTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

const startFakeWorkSocket = async (respond: (request: Record<string, unknown>) => unknown): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "junto-artifact-cli-"));
  roots.push(home);
  const workHome = join(home, ".junto", "work");
  await mkdir(workHome, { recursive: true });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      socket.end(`${JSON.stringify(respond(request))}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(workControlSocketPath(workHome), () => done());
  });
  return workHome;
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ID = "01M5ESMQ2ZT55QZ073EWPH10SG";
const OP = "01M5ESM1XHCJ7JYJDBC37MREBZ";

/** Runs one CLI call against a socket that answers ok and records the request. */
const sent = async (args: ReadonlyArray<string>) => {
  let observed: Record<string, unknown> | undefined;
  const workHome = await startFakeWorkSocket((request) => {
    observed = request;
    return { ok: true, op: request.op, protocol_version: WORK_PROTOCOL_VERSION, data: { disposition: "applied" } };
  });
  const result = await runCli(args, workHome);
  return { result, op: observed?.op, args: observed?.args as Record<string, unknown> | undefined };
};

describe("junto artifact discovery", () => {
  it.runIf(!ARTIFACTS_ENABLED)("lists no artifact verb while the surface is off", () => {
    expect(allSchemas.filter((s) => s.command_id.startsWith("artifact."))).toEqual([]);
  });

  it.runIf(ARTIFACTS_ENABLED)("has one schema and one capability per verb, and publish is gone", () => {
    const ids = [...ARTIFACT_OPS].sort();
    expect(allSchemas.filter((s) => s.command_id.startsWith("artifact.")).map((s) => s.command_id).sort()).toEqual(ids);
    expect(commandCapabilities.filter((c) => c.command_id.startsWith("artifact.")).map((c) => c.command_id).sort()).toEqual(ids);
    expect(allExamples.some((e) => e.command_id === "artifact.publish")).toBe(false);
  });

  it.runIf(ARTIFACTS_ENABLED)("has examples that decode under their verb's schema, ids as the CLI mints them", () => {
    for (const example of artifactExamples) {
      const contract = artifactSchemas.find((s) => s.command_id === example.command_id)!;
      expect(() => Schema.decodeUnknownSync(contract.schema as never, { onExcessProperty: "error" })(example.input), example.name).not.toThrow();
      expect(allExamples).toContainEqual(example);
    }
  });
});

describe("junto artifact", () => {
  it("creates with a minted opId and artifact id, the body from --markdown and the tasks it names", async () => {
    const { result, op, args } = await sent(["artifact", "create", "Notes", "--type", "document", "--markdown", "# hi", "--task", ID]);
    expect(result.code, result.stderr).toBe(0);
    expect(op).toBe("artifact.create");
    expect(args).toMatchObject({ type: "document", title: "Notes", body: { markdown: "# hi" }, taskIds: [ID] });
    expect(args?.opId).toMatch(ULID);
    expect(args?.artifactId).toMatch(ULID);
  });

  it("edits with patches against --base, and resends under --op-id", async () => {
    const { args } = await sent(["artifact", "edit", ID, "--base", "3", "--patch", '[{"op":"cell","rowId":"r1","columnId":"c1","value":"4"}]', "--op-id", OP]);
    expect(args).toEqual({ opId: OP, artifact: ID, baseVersion: 3, patches: [{ op: "cell", rowId: "r1", columnId: "c1", value: "4" }] });
  });

  it("comments at an anchor, and reads with no opId", async () => {
    const comment = await sent(["artifact", "comment", ID, "look here", "--anchor", '{"kind":"cells","range":"B2"}']);
    expect(comment.args).toMatchObject({ artifact: ID, text: "look here", anchor: { kind: "cells", range: "B2" } });
    const show = await sent(["artifact", "show", ID, "--version", "2"]);
    expect(show.args).toEqual({ artifact: ID, version: 2 });
    const list = await sent(["artifact", "list", "--archived", "--type", "sheet"]);
    expect(list.args).toEqual({ archived: true, type: "sheet" });
  });

  it("refuses two bodies and JSON that does not parse, before anything is sent", async () => {
    const both = await sent(["artifact", "edit", ID, "--base", "1", "--markdown", "a", "--url", "https://x.dev"]);
    expect(both.op).toBeUndefined();
    expect(both.result.code).not.toBe(0);
    const broken = await sent(["artifact", "comment", ID, "x", "--anchor", "{cells"]);
    expect(broken.op).toBeUndefined();
    expect(broken.result.stdout + broken.result.stderr).toContain("--anchor");
  });
});
