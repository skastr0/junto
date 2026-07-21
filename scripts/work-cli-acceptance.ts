#!/usr/bin/env bun
/**
 * Live acceptance for the work control plane + compiled `dist/vellum`.
 *
 * Boots the real NDJSON work control daemon (WorkService + CanvasesService)
 * against a sandboxed work home, then drives the compiled CLI from a cwd
 * outside the repo. Proves doctor/onboard/capabilities/claim/batch/scope/
 * artifact/request + 0600 token + wrong-token AuthError without fighting
 * Electron's single-instance lock.
 *
 *   bun run cli:build && bun scripts/work-cli-acceptance.ts
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CanvasesLive } from "../src/main/vellum/canvases";
import { startWorkControlServer } from "../src/main/vellum/work/control";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import { makeProcessIdentityMap } from "../src/main/vellum/process-identity";

const REPO = process.cwd();
const CLI = join(REPO, "dist/vellum");
const CANVAS = "work-acc";
const AGENT = "agent";
const TASKS = "tasks";
const REQS = "req";
const ARTS = "art";

const seed = () => ({
  nodes: [
    {
      id: AGENT,
      type: "text",
      x: 40,
      y: 40,
      width: 140,
      height: 56,
      text: "agent",
      ether: { entity: { kind: "agent", name: "local:default" } },
    },
    {
      id: TASKS,
      type: "text",
      x: 240,
      y: 40,
      width: 160,
      height: 80,
      text: "ship it",
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "t1",
              state: "submitted",
              history: [
                {
                  messageId: "m0",
                  role: "user",
                  parts: [{ kind: "text", text: "ship it" }],
                  contextId: CANVAS,
                  taskId: "t1",
                },
              ],
            },
            {
              id: "t2",
              state: "submitted",
              history: [
                {
                  messageId: "m1",
                  role: "user",
                  parts: [{ kind: "text", text: "also this" }],
                  contextId: CANVAS,
                  taskId: "t2",
                },
              ],
            },
          ],
        },
      },
    },
    {
      id: REQS,
      type: "text",
      x: 440,
      y: 40,
      width: 160,
      height: 80,
      text: "0 pending",
      ether: { entity: { kind: "requests" }, requests: { items: [] } },
    },
    {
      id: ARTS,
      type: "text",
      x: 640,
      y: 40,
      width: 160,
      height: 80,
      text: "artifacts",
      ether: { entity: { kind: "artifacts" }, artifacts: { items: [] } },
    },
    {
      id: "region",
      type: "group",
      x: 0,
      y: 0,
      width: 900,
      height: 200,
      label: "Acceptance",
      ether: { region: { hold: false, instruction: "accept the work plane" } },
    },
  ],
  edges: [
    { id: "e-tasks", fromNode: AGENT, toNode: TASKS },
    { id: "e-req", fromNode: AGENT, toNode: REQS },
    { id: "e-art", fromNode: AGENT, toNode: ARTS },
  ],
});

const runCli = (
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn(CLI, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });

const log = (label: string, body: string) => {
  process.stdout.write(`\n### ${label}\n${body.trim()}\n`);
};

const main = async () => {
  if (!existsSync(CLI)) {
    console.error("missing dist/vellum — run bun run cli:build");
    process.exit(2);
  }

  const root = await mkdtemp(join(tmpdir(), "vellum-work-acc-"));
  const canvases = join(root, "canvases");
  const workHome = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(canvases, { recursive: true });
  mkdirSync(workHome, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(canvases, `${CANVAS}.canvas`), JSON.stringify(seed(), null, 2));
  const artifactPath = join(outside, "report.txt");
  writeFileSync(artifactPath, "acceptance artifact body\n");

  process.env.VELLUM_CANVASES_DIR = canvases;
  process.env.VELLUM_WORK_HOME = workHome;

  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkLive, CanvasesLive));
  // Bind the acceptance runner PID. CLI children walk PPID to this process.
  const processMap = makeProcessIdentityMap();
  processMap.bind(process.pid, { kind: "agent", agentKey: "local:default" });

  const server = await startWorkControlServer({
    version: "acceptance",
    workHome,
    home: root,
    canvasesDir: canvases,
    processMap,
    run: (effect) => runtime.runPromise(effect),
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VELLUM_WORK_HOME: workHome,
    // Identity is process-bind — no VELLUM_NODE_REF.
  };

  try {
    const sockMode = (await stat(server.socketPath)).mode & 0o777;
    const tokMode = (await stat(server.tokenPath)).mode & 0o777;
    log(
      "A3 perms",
      JSON.stringify({
        socket: sockMode.toString(8),
        token: tokMode.toString(8),
        socket_path: server.socketPath,
        token_path: server.tokenPath,
      }),
    );

    const doctor = await runCli(["doctor"], env, outside);
    log("doctor", doctor.stdout || doctor.stderr);

    const onboard = await runCli(["onboard"], env, outside);
    log("onboard", onboard.stdout || onboard.stderr);

    const caps = await runCli(["capabilities"], env, outside);
    log("capabilities", caps.stdout || caps.stderr);

    const claim = await runCli(
      ["tasks", "claim", JSON.stringify({ target: TASKS, task: "t1", actor: AGENT })],
      env,
      outside,
    );
    log("tasks claim", claim.stdout || claim.stderr);

    const batch = await runCli(
      [
        "tasks",
        "update",
        JSON.stringify([
          { target: TASKS, task: "t1", state: "completed", note: "done" },
          { target: TASKS, task: "missing", state: "completed" },
        ]),
        "--concurrency",
        "2",
      ],
      env,
      outside,
    );
    log(`tasks update batch exit=${batch.code}`, batch.stdout || batch.stderr);

    const req = await runCli(
      [
        "request",
        "create",
        JSON.stringify({
          target: REQS,
          brief: "approve ship?",
          metadata: { from: "acceptance" },
        }),
      ],
      env,
      outside,
    );
    log("request create", req.stdout || req.stderr);

    // Resolve request via WorkService (UI path analogue) so block would clear.
    const reqBody = JSON.parse(req.stdout || "{}");
    const createdId =
      reqBody?.data?.results?.[0]?.ok === true
        ? reqBody.data.results[0].data.id
        : undefined;
    if (createdId) {
      const resolved = await runtime.runPromise(
        Effect.gen(function* () {
          const work = yield* WorkService;
          return yield* work.workRequestResolve(
            CANVAS,
            REQS,
            createdId,
            "approved",
            "completed",
          );
        }),
      );
      log("request resolve (service)", JSON.stringify(resolved));
    }

    const art = await runCli(
      [
        "artifact",
        "publish",
        JSON.stringify({
          target: ARTS,
          name: "report",
          parts: [{ kind: "raw", path: artifactPath }],
        }),
      ],
      env,
      outside,
    );
    log("artifact publish", art.stdout || art.stderr);

    const scope = await runCli(
      ["tasks", "list", JSON.stringify({ target: "no-such-node" })],
      env,
      outside,
    );
    log("scope error", scope.stdout || scope.stderr);

    const wrongTok = await new Promise<string>((resolveP, reject) => {
      const s = createConnection({ path: server.socketPath });
      let buf = Buffer.alloc(0);
      s.on("connect", () => {
        s.write(
          `${JSON.stringify({
            token: "0".repeat(64),
            op: "ping",
          })}\n`,
        );
      });
      s.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buf = Buffer.concat([buf, part]);
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        s.destroy();
        resolveP(buf.subarray(0, nl).toString("utf8"));
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 5000);
    });
    log("A3 wrong token", wrongTok);

    const docAfter = JSON.parse(readFileSync(join(canvases, `${CANVAS}.canvas`), "utf8"));
    log(
      "canvas after",
      JSON.stringify(
        {
          tasks: docAfter.nodes
            .find((n: { id: string }) => n.id === TASKS)
            ?.ether?.tasks?.items?.map((t: { id: string; state: string }) => ({
              id: t.id,
              state: t.state,
            })),
          requests: docAfter.nodes
            .find((n: { id: string }) => n.id === REQS)
            ?.ether?.requests?.items?.map((t: { id: string; state: string }) => ({
              id: t.id,
              state: t.state,
            })),
          artifacts: docAfter.nodes
            .find((n: { id: string }) => n.id === ARTS)
            ?.ether?.artifacts?.items?.map((a: { name?: string; artifactId: string }) => ({
              id: a.artifactId,
              name: a.name,
            })),
        },
        null,
        2,
      ),
    );

    const claimOk = (() => {
      try {
        const j = JSON.parse(claim.stdout);
        return j.ok === true && j.data?.outcome === "succeeded";
      } catch {
        return false;
      }
    })();
    const batchOk = (() => {
      try {
        const j = JSON.parse(batch.stdout);
        return j.ok === true && j.data?.outcome === "partial_failure" && batch.code === 1;
      } catch {
        return false;
      }
    })();
    const scopeOk = (scope.stderr || scope.stdout).includes("ScopeError");
    const authOk = wrongTok.includes("AuthError");
    const artOk = (() => {
      try {
        const j = JSON.parse(art.stdout);
        return j.ok === true && j.data?.outcome === "succeeded";
      } catch {
        return false;
      }
    })();
    const doctorOk = doctor.stdout.includes("protocol_version");

    console.log("\n=== verdict ===");
    console.log(
      JSON.stringify(
        {
          doctor: doctorOk,
          claim: claimOk,
          batch_partial: batchOk,
          scope: scopeOk,
          artifact: artOk,
          auth: authOk,
          token_0600: tokMode === 0o600,
        },
        null,
        2,
      ),
    );

    if (!doctorOk || !claimOk || !batchOk || !scopeOk || !authOk || !artOk || tokMode !== 0o600) {
      process.exitCode = 1;
    }
  } finally {
    server.close();
    await runtime.dispose();
    delete process.env.VELLUM_CANVASES_DIR;
    delete process.env.VELLUM_WORK_HOME;
    await rm(root, { recursive: true, force: true });
  }

  void chmodSync;
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
