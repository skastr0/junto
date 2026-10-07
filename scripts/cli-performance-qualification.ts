/** Isolated packaged-agent CLI qualification. Never connects to the operator's runtime. */
import { createConnection } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Layer, ManagedRuntime } from "effect";
import { unitTestEnvironment } from "./unit-test-environment";
import { WORK_TOKEN_ENV } from "../src/shared/work-control";

const [, , mode, ...args] = process.argv;

const serve = async (root: string) => {
  const [{ makeStateEngineLive }, { makeInstallOpsLive }, { CanvasesLive, CanvasesService },
    { WorkLive }, { WorkRepositoryLive }, { CrewRepositoryLive }, { AgentSignalRepositoryLive },
    { StationRepositoryLive }, { StationFleetTargetRepositoryLive }, { StationLivePeerRegistryLive },
    { SettingsLive, SettingsService }, { makeContentServiceLive }, { PausePlaneAllPlaying },
    { startWorkControlServer }, { makeSeatCredentialRegistry, mintSeatCredential }, { makeProcessIdentityMap }] = await Promise.all([
    import("../src/main/junto/state/engine"), import("../src/main/junto/install-ops/engine"),
    import("../src/main/junto/canvases"), import("../src/main/junto/work/service"),
    import("../src/main/junto/work/repository"), import("../src/main/junto/work/crew-repository"),
    import("../src/main/junto/signals/repository"), import("../src/main/junto/station/repository"),
    import("../src/main/junto/station/fleet-target-repository"), import("../src/main/junto/station/session-registry"),
    import("../src/main/junto/settings/service"), import("../src/main/junto/content/service"),
    import("../src/main/junto/pause-plane"), import("../src/main/junto/work/control"),
    import("../src/main/junto/work/seat-credentials"), import("../src/main/junto/process-identity"),
  ]);
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive, CrewRepositoryLive, AgentSignalRepositoryLive, StationRepositoryLive,
    StationFleetTargetRepositoryLive, SettingsLive,
    makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db"))));
  const canvases = Layer.provideMerge(CanvasesLive, repositories);
  const runtime = ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive,
    Layer.mergeAll(canvases, StationLivePeerRegistryLive)), PausePlaneAllPlaying));
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true }));
  const canvasService = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvasService.write("cli-performance", { nodes: [{
    id: "agent", type: "text", text: "qualification", x: 0, y: 0, width: 120, height: 48,
    ether: { entity: { kind: "agent", name: "local:qualification" }, terminal: {
      bindingId: "qualification", harness: "codex", launch: { kind: "harness", argv: ["codex"] },
    } },
  }], edges: [] }));
  const credentials = makeSeatCredentialRegistry();
  const mint = mintSeatCredential();
  if (!credentials.publish(mint, { agentKey: "local:qualification", bindingId: "qualification", canvasName: "cli-performance", nodeId: "agent" })) throw new Error("credential publish failed");
  let processObservations = 0;
  const observed = (): never => { processObservations++; throw new Error("ordinary CLI attempted process observation"); };
  const processMap = makeProcessIdentityMap({ readParentPid: observed, readProcessStartKey: observed, processAlive: observed });
  const server = await startWorkControlServer({ home: root, workHome: join(root, "work"), version: "qualification",
    credentials, processMap: new Proxy(processMap, { get(target, key) { return key === "snapshot" || key === "resolve" ? observed : Reflect.get(target, key); } }),
    readPeerPid: observed, run: (effect) => runtime.runPromise(effect),
  });
  let last = performance.now(), maxGap = 0, beats = 0;
  const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; beats++; }, 1);
  process.on("message", async (message: { type: string }) => {
    if (message.type === "reset") { last = performance.now(); maxGap = 0; beats = 0; process.send?.({ type: "reset" }); }
    if (message.type === "sample") process.send?.({ type: "sample", max_gap_ms: maxGap, heartbeat_count: beats, process_observations: processObservations });
    if (message.type === "shutdown") {
      clearInterval(heartbeat); credentials.revoke(mint.credential, "seat-closed");
      await server.close(); await runtime.dispose(); process.exit(0);
    }
  });
  process.send?.({ type: "ready", socket: server.socketPath, credential: mint.credential });
};

const qualify = async (output: string, beforePath: string, afterPath: string) => {
  const before = resolve(beforePath), after = resolve(afterPath);
  const root = await mkdtemp(join(tmpdir(), "junto-cli-perf-"));
  const ambient = Object.fromEntries(Object.entries(unitTestEnvironment(process.env)).filter(([name]) => !name.startsWith("JUNTO_")));
  const childEnv = { ...ambient, JUNTO_HOME: root, JUNTO_WORK_HOME: join(root, "work") };
  let receiver: ((message: Record<string, unknown>) => void) | undefined;
  const receive = (type: string) => new Promise<Record<string, unknown>>((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server ${type} timeout`)), 15_000);
    receiver = (message) => { if (message.type === type) { clearTimeout(timeout); receiver = undefined; resolveMessage(message); } };
  });
  const ready = receive("ready");
  const child = Bun.spawn([process.execPath, import.meta.path, "--server", root], {
    env: childEnv, stdout: "ignore", stderr: "inherit", ipc: (message) => receiver?.(message),
  });
  try {
    const receipt = await ready;
    const credential = String(receipt.credential), socketPath = String(receipt.socket);
    const env = { ...childEnv, [WORK_TOKEN_ENV]: credential };
    const cli = async (path: string, argv: string[]) => {
      const start = performance.now();
      const proc = Bun.spawn([path, ...argv], { env, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (exit !== 0 || (argv[0] === "ping" && JSON.parse(stdout).ok !== true)) throw new Error(`CLI qualification failed: ${argv[0]} exit=${exit} ${stderr}`);
      return performance.now() - start;
    };
    const direct = async () => {
      const start = performance.now();
      await new Promise<void>((resolveCall, reject) => {
        const socket = createConnection({ path: socketPath }); let buffer = "";
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("direct ping timeout")); }, 10_000);
        socket.on("connect", () => socket.write(JSON.stringify({ token: credential, op: "ping" }) + "\n"));
        socket.on("data", (chunk) => { buffer += chunk.toString(); if (!buffer.includes("\n")) return;
          clearTimeout(timer); socket.destroy(); JSON.parse(buffer.split("\n")[0]).ok === true ? resolveCall() : reject(new Error("direct ping denied")); });
        socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      });
      return performance.now() - start;
    };
    const groups: Record<string, unknown>[] = [];
    let round = 0;
    const group = async (label: string, n: number, concurrency: number, call: () => Promise<number>) => {
      const reset = receive("reset"); child.send({ type: "reset" }); await reset;
      const start = performance.now();
      const rows = await Effect.runPromise(Effect.forEach(Array.from({ length: n }), () => Effect.promise(call), { concurrency }));
      const wall = performance.now() - start;
      const sample = receive("sample"); child.send({ type: "sample" }); const heartbeat = await sample;
      rows.sort((a, b) => a - b);
      const result: Record<string, unknown> = { label, round, timings_ms: rows, n, success_count: rows.length, concurrency, wall_ms: wall, median_ms: (rows[Math.floor((n - 1) / 2)] + rows[Math.floor(n / 2)]) / 2,
        p95_ms: rows[Math.ceil(n * .95) - 1], max_ms: rows[n - 1], ...heartbeat };
      delete result.type;
      groups.push(result); process.stdout.write(JSON.stringify(result) + "\n");
      if (heartbeat.process_observations !== 0) throw new Error("ordinary identity observed a process");
    };
    // Warm both executables and the runtime before controlled comparisons.
    await cli(before, ["ping"]); await cli(after, ["ping"]);
    for (const argv of [["doctor"], ["onboard"], ["capabilities"], ["msg", "list"], ["schema", "show", "msg.send"], ["examples", "show", "msg.send"]]) await cli(after, argv);
    const variants = [["eager", before], ["lazy", after]] as const;
    // Balance execution order rather than attribute a changing desktop load to code.
    for (round = 0; round < 2; round++) {
      for (const [label, path] of round === 0 ? variants : [...variants].reverse()) {
        await group(`${label}_version_serial`, 12, 1, () => cli(path, ["--version"]));
        await group(`${label}_ping_serial`, 12, 1, () => cli(path, ["ping"]));
        await group(`${label}_ping_burst_24`, 24, 24, () => cli(path, ["ping"]));
      }
    }
    await group("token_direct_fresh_ping_serial", 12, 1, direct);
    await group("token_direct_fresh_ping_burst_24", 24, 24, direct);
    await group("token_direct_fresh_ping_burst_64", 64, 64, direct);
    const evidence = { captured_at: new Date().toISOString(), platform: process.platform, arch: process.arch,
      qualification: "isolated real Work/Canvases/SQLite runtime in separate Bun process; no installed app or renderer",
      sha256: { eager: createHash("sha256").update(await readFile(before)).digest("hex"), lazy: createHash("sha256").update(await readFile(after)).digest("hex") }, groups };
    await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  } finally {
    if (child.exitCode === null) {
      try { child.send({ type: "shutdown" }); } catch { child.kill(); }
    }
    const timeout = setTimeout(() => child.kill(), 10_000);
    await child.exited; clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  if (mode === "--server") await serve(args[0]);
  else if (mode && args.length === 2) await qualify(mode, args[0], args[1]);
  else throw new Error("usage: bun scripts/cli-performance-qualification.ts OUTPUT_JSON EAGER_CLI LAZY_CLI");
}
