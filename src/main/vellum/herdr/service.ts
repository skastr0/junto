import { spawn } from "node:child_process";
import { runCli, type CliResult } from "../adapters/exec";
import { HERDR_HOSTS, herdrArgv, isKnownHerdrHost, UnknownHerdrHostError, type HerdrHostDef } from "./hosts";
import {
  parseCliEnvelope,
  parseCreateIds,
  parsePaneGet,
  parsePaneList,
  parseSessionList,
  parseTabList,
  parseWorkspaceList,
  type HerdrPaneRow,
  type HerdrSessionRow,
  type HerdrTabRow,
  type HerdrWorkspaceRow,
} from "./parse";

export type HerdrErrorCode =
  | "unreachable"
  | "missing"
  | "timeout"
  | "not_found"
  | "failed"
  | "invalid";

export interface HerdrResultOk<T> {
  readonly ok: true;
  readonly data: T;
}

export interface HerdrResultErr {
  readonly ok: false;
  readonly code: HerdrErrorCode;
  readonly message: string;
}

export type HerdrResult<T> = HerdrResultOk<T> | HerdrResultErr;

export interface HerdrPaneMeta extends HerdrPaneRow {
  readonly preview?: string;
}

export type HerdrRunner = (
  hostId: string,
  args: ReadonlyArray<string>,
  session?: string | null,
  timeoutMs?: number,
) => Promise<CliResult>;

const defaultRunner: HerdrRunner = async (hostId, args, session, timeoutMs = 12_000) => {
  const { command, argv } = herdrArgv(hostId, args, session);
  return runCli(command, argv, timeoutMs);
};

const mapCliFailure = (result: CliResult, hostId: string): HerdrResultErr => {
  const err = result.error ?? "herdr command failed";
  if (/ENOENT|not found|command not found/i.test(err)) {
    return { ok: false, code: "missing", message: `herdr not available on ${hostId}: ${err}` };
  }
  if (/ETIMEDOUT|timeout|ConnectTimeout|Connection timed out/i.test(err)) {
    return { ok: false, code: "timeout", message: `herdr timeout on ${hostId}: ${err}` };
  }
  if (/ECONNREFUSED|Connection refused|Network is unreachable|No route to host|Permission denied/i.test(err)) {
    return { ok: false, code: "unreachable", message: `host ${hostId} unreachable: ${err}` };
  }
  return { ok: false, code: "failed", message: err };
};

const requireHost = (hostId: string): HerdrResultErr | null => {
  if (!isKnownHerdrHost(hostId) || hostId.startsWith("-")) {
    return { ok: false, code: "invalid", message: `unknown herdr host: ${hostId}` };
  }
  return null;
};

const runEnvelope = async (
  runner: HerdrRunner,
  hostId: string,
  args: ReadonlyArray<string>,
  session?: string | null,
  timeoutMs?: number,
): Promise<HerdrResult<unknown>> => {
  const bad = requireHost(hostId);
  if (bad) return bad;
  let cli: CliResult;
  try {
    cli = await runner(hostId, args, session, timeoutMs);
  } catch (error) {
    if (error instanceof UnknownHerdrHostError) {
      return { ok: false, code: "invalid", message: error.message };
    }
    throw error;
  }
  if (!cli.ok) return mapCliFailure(cli, hostId);
  const envelope = parseCliEnvelope(cli.stdout);
  if (!envelope.ok) {
    const code: HerdrErrorCode =
      /not_found|pane_not_found|unknown/i.test(envelope.code) ? "not_found" : "failed";
    return { ok: false, code, message: envelope.message };
  }
  return { ok: true, data: envelope.result };
};

export class HerdrService {
  constructor(private readonly runner: HerdrRunner = defaultRunner) {}

  hosts(): ReadonlyArray<HerdrHostDef> {
    return HERDR_HOSTS;
  }

  async ensureServer(
    hostId: string,
    session?: string | null,
  ): Promise<HerdrResult<{ readonly running: boolean; readonly started: boolean }>> {
    const bad = requireHost(hostId);
    if (bad) return bad;
    // status is cheap; if server is up we're done.
    let status: CliResult;
    try {
      status = await this.runner(hostId, ["status", "--json"], session, 8_000);
    } catch (error) {
      if (error instanceof UnknownHerdrHostError) {
        return { ok: false, code: "invalid", message: error.message };
      }
      throw error;
    }
    if (status.ok) {
      try {
        const parsed = JSON.parse(status.stdout.trim()) as {
          server?: { running?: boolean; status?: string };
        };
        if (parsed.server?.running === true || parsed.server?.status === "running") {
          return { ok: true, data: { running: true, started: false } };
        }
      } catch {
        // fall through to start
      }
    } else if (/ENOENT|not found|command not found/i.test(status.error ?? "")) {
      return mapCliFailure(status, hostId);
    } else if (/ECONNREFUSED|ConnectTimeout|timed out|Permission denied|No route/i.test(status.error ?? "")) {
      return mapCliFailure(status, hostId);
    }

    // Spawn headless server (detached). API CLI does not autostart.
    let command: string;
    let argv: string[];
    try {
      ({ command, argv } = herdrArgv(hostId, ["server"], session));
    } catch (error) {
      if (error instanceof UnknownHerdrHostError) {
        return { ok: false, code: "invalid", message: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "failed", message };
    }
    try {
      const child = spawn(command, argv, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "failed", message: `failed to spawn herdr server on ${hostId}: ${message}` };
    }

    // Poll until status accepts (bounded).
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const poll = await this.runner(hostId, ["status", "--json"], session, 6_000);
      if (!poll.ok) continue;
      try {
        const parsed = JSON.parse(poll.stdout.trim()) as {
          server?: { running?: boolean; status?: string };
        };
        if (parsed.server?.running === true || parsed.server?.status === "running") {
          return { ok: true, data: { running: true, started: true } };
        }
      } catch {
        // continue
      }
    }
    return {
      ok: false,
      code: "timeout",
      message: `herdr server on ${hostId} did not become ready`,
    };
  }

  async listSessions(hostId: string): Promise<HerdrResult<ReadonlyArray<HerdrSessionRow>>> {
    const bad = requireHost(hostId);
    if (bad) return bad;
    const cli = await this.runner(hostId, ["session", "list", "--json"], null, 10_000);
    if (!cli.ok) return mapCliFailure(cli, hostId);
    try {
      const parsed = JSON.parse(cli.stdout.trim()) as unknown;
      // session list --json is bare `{ sessions: [...] }`, not always envelope.
      const sessions = parseSessionList(parsed);
      return { ok: true, data: sessions };
    } catch {
      const envelope = parseCliEnvelope(cli.stdout);
      if (!envelope.ok) return { ok: false, code: "failed", message: envelope.message };
      return { ok: true, data: parseSessionList(envelope.result) };
    }
  }

  async listWorkspaces(
    hostId: string,
    session?: string | null,
  ): Promise<HerdrResult<ReadonlyArray<HerdrWorkspaceRow>>> {
    const res = await runEnvelope(this.runner, hostId, ["workspace", "list"], session);
    if (!res.ok) return res;
    return { ok: true, data: parseWorkspaceList(res.data) };
  }

  async listTabs(
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ): Promise<HerdrResult<ReadonlyArray<HerdrTabRow>>> {
    const args = workspaceId
      ? (["tab", "list", "--workspace", workspaceId] as const)
      : (["tab", "list"] as const);
    const res = await runEnvelope(this.runner, hostId, args, session);
    if (!res.ok) return res;
    return { ok: true, data: parseTabList(res.data) };
  }

  async listPanes(
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ): Promise<HerdrResult<ReadonlyArray<HerdrPaneRow>>> {
    const args = workspaceId
      ? (["pane", "list", "--workspace", workspaceId] as const)
      : (["pane", "list"] as const);
    const res = await runEnvelope(this.runner, hostId, args, session);
    if (!res.ok) return res;
    return { ok: true, data: parsePaneList(res.data) };
  }

  async listAgents(
    hostId: string,
    session?: string | null,
  ): Promise<HerdrResult<ReadonlyArray<HerdrPaneRow>>> {
    const res = await runEnvelope(this.runner, hostId, ["agent", "list"], session);
    if (!res.ok) return res;
    // agent list shares pane-shaped rows.
    return { ok: true, data: parsePaneList({ panes: (asArray(res.data, "agents")) }) };
  }

  async getPaneMeta(
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ): Promise<HerdrResult<HerdrPaneMeta>> {
    if (!paneId) return { ok: false, code: "invalid", message: "paneId required" };
    const res = await runEnvelope(this.runner, hostId, ["pane", "get", paneId], session);
    if (!res.ok) return res;
    const pane = parsePaneGet(res.data);
    if (!pane) return { ok: false, code: "not_found", message: `pane ${paneId} not found` };

    // Cheap preview — non-blocking failure.
    let preview: string | undefined;
    const read = await runEnvelope(
      this.runner,
      hostId,
      ["pane", "read", paneId, "--lines", "1", "--format", "text"],
      session,
      6_000,
    );
    if (read.ok) {
      const root = read.data && typeof read.data === "object" ? (read.data as Record<string, unknown>) : {};
      const text =
        (typeof root.text === "string" && root.text) ||
        (typeof root.content === "string" && root.content) ||
        (typeof root.preview === "string" && root.preview) ||
        "";
      const line = text.split("\n").map((s) => s.trim()).find(Boolean);
      if (line) preview = line.slice(0, 160);
    }

    return { ok: true, data: { ...pane, preview } };
  }

  async createWorkspace(
    hostId: string,
    session: string | null | undefined,
    input: { readonly cwd: string; readonly label?: string },
  ): Promise<HerdrResult<{ readonly workspaceId: string; readonly tabId?: string; readonly paneId?: string; readonly terminalId?: string }>> {
    if (!input.cwd) return { ok: false, code: "invalid", message: "cwd required" };
    const args = ["workspace", "create", "--cwd", input.cwd, "--no-focus"];
    if (input.label) args.push("--label", input.label);
    const res = await runEnvelope(this.runner, hostId, args, session);
    if (!res.ok) return res;
    const ids = parseCreateIds(res.data);
    if (!ids.workspaceId) {
      return { ok: false, code: "failed", message: "workspace create returned no workspace_id" };
    }
    return {
      ok: true,
      data: {
        workspaceId: ids.workspaceId,
        tabId: ids.tabId,
        paneId: ids.paneId,
        terminalId: ids.terminalId,
      },
    };
  }

  async createTab(
    hostId: string,
    session: string | null | undefined,
    input: { readonly workspaceId: string; readonly label?: string },
  ): Promise<HerdrResult<{ readonly tabId: string; readonly paneId?: string; readonly terminalId?: string }>> {
    if (!input.workspaceId) return { ok: false, code: "invalid", message: "workspaceId required" };
    const args = ["tab", "create", "--workspace", input.workspaceId, "--no-focus"];
    if (input.label) args.push("--label", input.label);
    const res = await runEnvelope(this.runner, hostId, args, session);
    if (!res.ok) return res;
    const ids = parseCreateIds(res.data);
    if (!ids.tabId) return { ok: false, code: "failed", message: "tab create returned no tab_id" };
    return {
      ok: true,
      data: { tabId: ids.tabId, paneId: ids.paneId, terminalId: ids.terminalId },
    };
  }

  async createPane(
    hostId: string,
    session: string | null | undefined,
    input: {
      readonly paneId?: string;
      readonly direction?: "right" | "down";
      readonly cwd?: string;
    },
  ): Promise<HerdrResult<{ readonly paneId: string; readonly terminalId?: string; readonly tabId?: string; readonly workspaceId?: string }>> {
    // Minimal P0: split from an existing pane (or focused) with --no-focus.
    const direction = input.direction ?? "right";
    const args: string[] = ["pane", "split", "--direction", direction, "--no-focus"];
    if (input.paneId) args.push(input.paneId);
    if (input.cwd) args.push("--cwd", input.cwd);
    const res = await runEnvelope(this.runner, hostId, args, session);
    if (!res.ok) return res;
    const ids = parseCreateIds(res.data);
    if (!ids.paneId) return { ok: false, code: "failed", message: "pane split returned no pane_id" };
    return {
      ok: true,
      data: {
        paneId: ids.paneId,
        terminalId: ids.terminalId,
        tabId: ids.tabId,
        workspaceId: ids.workspaceId,
      },
    };
  }

  async killPane(
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ): Promise<HerdrResult<{ readonly closed: true }>> {
    if (!paneId) return { ok: false, code: "invalid", message: "paneId required" };
    const res = await runEnvelope(this.runner, hostId, ["pane", "close", paneId], session);
    if (!res.ok) return res;
    return { ok: true, data: { closed: true } };
  }

  async killTab(
    hostId: string,
    session: string | null | undefined,
    tabId: string,
  ): Promise<HerdrResult<{ readonly closed: true }>> {
    if (!tabId) return { ok: false, code: "invalid", message: "tabId required" };
    const res = await runEnvelope(this.runner, hostId, ["tab", "close", tabId], session);
    if (!res.ok) return res;
    return { ok: true, data: { closed: true } };
  }
}

const asArray = (data: unknown, key: string): unknown[] => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
    // agent list result may nest under result.agents already unwrapped
    const agents = (data as Record<string, unknown>).agents;
    if (Array.isArray(agents)) return agents;
  }
  return [];
};

/** Singleton used by IPC (tests construct their own with a mock runner). */
export const herdrService = new HerdrService();
