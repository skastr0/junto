#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const socketPath = valueAfter("--daemon-socket");
const logPath = process.env.FAKE_PRIME_AGENT_LOG;
const forbiddenEnvKeys = () => Object.keys(process.env)
  .filter((key) => key === "PI_CODING_AGENT" || key.startsWith("PRIME_AGENT_INTERNAL_"))
  .sort();
const log = (event, fields = {}) => {
  if (!logPath) return;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      event,
      pid: process.pid,
      ppid: process.ppid,
      seat: process.env.FAKE_PRIME_AGENT_SEAT,
      ...fields,
    })}\n`,
  );
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitForExit = (child, milliseconds) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve(false);
  }, milliseconds);
  child.once("exit", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(true);
  });
});
const connectRequest = (request) => new Promise((resolve, reject) => {
  if (!socketPath) {
    reject(new Error("daemon socket missing"));
    return;
  }
  const socket = createConnection(socketPath);
  let data = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    socket.destroy();
    if (error) reject(error);
    else resolve(value);
  };
  const timeout = setTimeout(() => {
    finish(new Error("fake daemon request timed out"));
  }, 2_000);
  socket.once("error", (error) => finish(error));
  socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on("data", (chunk) => {
    data += chunk.toString("utf8");
    const newline = data.indexOf("\n");
    if (newline < 0) return;
    try {
      finish(undefined, JSON.parse(data.slice(0, newline)));
    } catch (error) {
      finish(error);
    }
  });
});

if (argv.includes("--version")) {
  process.stdout.write("0.7.1\n");
  process.exit(0);
} else if (argv[0] === "list") {
  try {
    const response = await connectRequest({ op: "list" });
    log("command.list", {
      socketPath,
      activeSessionIds: Array.isArray(response?.sessions)
        ? response.sessions.map((session) => session.activeSessionId)
        : [],
      forbiddenEnvKeys: forbiddenEnvKeys(),
    });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } catch (error) {
    log("command.list.error", {
      socketPath,
      message: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (argv[0] === "stop") {
  const activeSessionId = argv[1];
  try {
    const response = await connectRequest({ op: "stop", activeSessionId });
    if (!response?.success) throw new Error(response?.error ?? "stop failed");
    log("command.stop", {
      socketPath,
      activeSessionId,
      forbiddenEnvKeys: forbiddenEnvKeys(),
    });
    process.stdout.write(`${JSON.stringify({
      id: "daemon_1",
      type: "response",
      command: "kill",
      success: true,
    }, null, 2)}\n`);
  } catch (error) {
    log("command.stop.error", {
      socketPath,
      activeSessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (valueAfter("--mode") === "daemon") {
  if (!socketPath) throw new Error("daemon socket missing");
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {}

  const sessions = new Map();
  let stopping = false;
  const stopWorker = async (id) => {
    const entry = sessions.get(id);
    if (!entry) return false;
    log("daemon.root-stop.begin", {
      socketPath,
      activeSessionId: id,
      workerPid: entry.child.pid,
    });
    entry.child.kill("SIGTERM");
    let exited = await waitForExit(entry.child, 1_000);
    if (!exited) {
      entry.child.kill("SIGKILL");
      exited = await waitForExit(entry.child, 500);
    }
    if (sessions.get(id) === entry) sessions.delete(id);
    log("daemon.root-stop.end", {
      socketPath,
      activeSessionId: id,
      workerPid: entry.child.pid,
      workerExited: exited,
    });
    return exited;
  };

  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      let request;
      try {
        request = JSON.parse(data.slice(0, newline));
      } catch {
        socket.end(`${JSON.stringify({ error: "bad json" })}\n`);
        return;
      }
      if (request.op === "list") {
        socket.end(`${JSON.stringify({
          sessions: [...sessions.entries()].map(([id, entry]) => ({
            id,
            activeSessionId: id,
            sessionId: entry.sessionId,
            runtimeKind: "top-level",
            rlmDepth: 0,
            lifecycle: "live",
            activity: "idle",
            isSessionActive: false,
            workerState: "ready",
            workerPid: entry.child.pid,
            cwd: entry.cwd,
            attachedClients: entry.clients,
            messageCount: 0,
            sessionActions: { queuedCount: 0, steering: [], followUps: [] },
          })),
        })}\n`);
        return;
      }
      if (request.op === "create") {
        const id = randomUUID().replaceAll("-", "").slice(0, 12);
        const sessionId = randomUUID();
        const child = spawn(
          process.execPath,
          [process.argv[1], "__worker", id, sessionId],
          {
            cwd: request.cwd,
            detached: true,
            env: { ...process.env, ...request.env },
            stdio: "ignore",
          },
        );
        const entry = { child, sessionId, cwd: request.cwd, clients: 1 };
        sessions.set(id, entry);
        child.once("exit", (code, signal) => {
          if (sessions.get(id) === entry) sessions.delete(id);
          log("daemon.worker-exit", {
            socketPath,
            activeSessionId: id,
            workerPid: child.pid,
            code,
            signal,
          });
        });
        child.unref();
        log("daemon.create", {
          id,
          sessionId,
          workerPid: child.pid,
          socketPath,
        });
        socket.end(`${JSON.stringify({ activeSessionId: id, sessionId })}\n`);
        return;
      }
      if (request.op === "detach") {
        const entry = sessions.get(request.activeSessionId);
        if (entry) entry.clients = Math.max(0, entry.clients - 1);
        log("daemon.detach", {
          socketPath,
          activeSessionId: request.activeSessionId,
          attachedClients: entry?.clients ?? 0,
        });
        socket.end(`${JSON.stringify({ ok: true })}\n`);
        return;
      }
      if (request.op === "stop") {
        void stopWorker(request.activeSessionId).then((success) => {
          socket.end(`${JSON.stringify(
            success
              ? { success: true }
              : { success: false, error: "unknown agent" },
          )}\n`);
        });
        return;
      }
      socket.end(`${JSON.stringify({ error: "unknown op" })}\n`);
    });
  });
  server.on("error", (error) => {
    log("daemon.error", { socketPath, message: error.message });
    process.exitCode = 1;
  });
  server.listen(socketPath, () => log("daemon.ready", { socketPath }));
  const close = (signal) => {
    if (stopping) return;
    stopping = true;
    const active = sessions.size;
    log("daemon.signal", { signal, active, socketPath });
    server.close();
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {}
    if (active === 0) {
      log("daemon.stop", { signal, active, socketPath, clean: true });
      process.exit(signal === "SIGTERM" ? 143 : 0);
    }
    // A supervisor signal with live resident roots must not claim that the
    // detached workers were cleaned. The manager is expected to stop roots
    // through the exact daemon socket before signaling this process.
    log("daemon.stop", { signal, active, socketPath, clean: false });
    setTimeout(() => process.exit(2), 20).unref();
  };
  process.on("SIGTERM", () => close("SIGTERM"));
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGHUP", () => close("SIGHUP"));
  log("daemon.start", {
    socketPath,
    argv,
    herdrPaneId: process.env.HERDR_PANE_ID,
    reporterSocket: process.env.HERDR_SOCKET_PATH,
    forbiddenEnvKeys: forbiddenEnvKeys(),
  });
} else if (argv[0] === "__tool") {
  const activeSessionId = argv[1];
  let closing = false;
  const close = (signal) => {
    if (closing) return;
    closing = true;
    log("tool.stop", { activeSessionId, signal });
    process.exit(0);
  };
  process.on("SIGTERM", () => close("SIGTERM"));
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGHUP", () => close("SIGHUP"));
  log("tool.start", {
    activeSessionId,
    forbiddenEnvKeys: forbiddenEnvKeys(),
  });
  setInterval(() => {}, 1_000);
} else if (argv[0] === "__worker") {
  const activeSessionId = argv[1];
  const sessionId = argv[2];
  const report = (method, params) => new Promise((resolve) => {
    const path = process.env.HERDR_SOCKET_PATH;
    if (!path) {
      resolve(undefined);
      return;
    }
    const socket = createConnection(path);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(undefined);
    };
    socket.once("error", done);
    socket.once("connect", () => socket.write(`${JSON.stringify({
      id: `fake:${process.pid}:${Date.now()}`,
      method,
      params,
    })}\n`));
    socket.once("data", done);
    setTimeout(done, 500).unref();
  });
  const pane = process.env.HERDR_PANE_ID;
  const source = "herdr:pi";
  const agent = "prime-agent";
  const seq = Date.now() * 1_000;
  const tool = spawn(
    process.execPath,
    [process.argv[1], "__tool", activeSessionId],
    { detached: true, env: { ...process.env }, stdio: "ignore" },
  );
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    log("worker.signal", { activeSessionId, signal, toolPid: tool.pid });
    tool.kill("SIGTERM");
    let toolExited = await waitForExit(tool, 750);
    if (!toolExited) {
      tool.kill("SIGKILL");
      toolExited = await waitForExit(tool, 250);
    }
    await report("pane.release_agent", {
      pane_id: pane,
      source,
      agent,
      seq: seq + 1,
    });
    log("worker.stop", { activeSessionId, signal, toolPid: tool.pid, toolExited });
    process.exit(toolExited ? 0 : 2);
  };
  process.on("SIGTERM", () => void close("SIGTERM"));
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGHUP", () => void close("SIGHUP"));
  log("worker.start", {
    activeSessionId,
    sessionId,
    toolPid: tool.pid,
    pane,
    reporterSocket: process.env.HERDR_SOCKET_PATH,
    forbiddenEnvKeys: forbiddenEnvKeys(),
  });
  // LocalSessionHost binds the PTY generation immediately after native spawn.
  // A real worker reports on its first state transition, not synchronously from
  // the daemon create response; this short delay preserves that ordering.
  await delay(100);
  if (!closing) {
    await report("pane.report_agent", {
      pane_id: pane,
      source,
      agent,
      state: "idle",
      seq,
      agent_session_path: `/tmp/${sessionId}.jsonl`,
    });
    log("worker.report", { activeSessionId, sessionId, pane, state: "idle" });
  }
  setInterval(() => {}, 1_000);
} else {
  if (!socketPath) {
    process.stderr.write("Error: daemon socket missing\n");
    process.exit(1);
  }
  try {
    const created = await connectRequest({
      op: "create",
      cwd: process.cwd(),
      env: {
        HERDR_ENV: process.env.HERDR_ENV,
        HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
        HERDR_PANE_ID: process.env.HERDR_PANE_ID,
        FAKE_PRIME_AGENT_LOG: process.env.FAKE_PRIME_AGENT_LOG,
      },
    });
    log("client.start", {
      argv,
      activeSessionId: created.activeSessionId,
      sessionId: created.sessionId,
      socketPath,
      pane: process.env.HERDR_PANE_ID,
      forbiddenEnvKeys: forbiddenEnvKeys(),
    });
    let closing = false;
    const close = async (signal) => {
      if (closing) return;
      closing = true;
      try {
        await connectRequest({ op: "detach", activeSessionId: created.activeSessionId });
      } catch {}
      log("client.stop", { activeSessionId: created.activeSessionId, signal });
      process.exit(0);
    };
    process.on("SIGTERM", () => void close("SIGTERM"));
    process.on("SIGINT", () => void close("SIGINT"));
    process.on("SIGHUP", () => void close("SIGHUP"));
    process.stdin.resume();
    setInterval(() => {}, 1_000);
  } catch (error) {
    log("client.error", {
      socketPath,
      message: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
