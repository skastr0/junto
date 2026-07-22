import type { CliResult } from "../adapters/exec";
import { getProcessIdentityMap } from "../process-identity";
import { findHostById } from "../hosts/snapshot";
import { isKnownHerdrHost, listHerdrHosts, UnknownHerdrHostError, type HerdrHostDef } from "./hosts";
import type { HerdrMirrorReads } from "./mirror";
import type { HerdrServerRoute } from "./route";
import {
  awaitHerdrPromiseFixedPoint,
  cleanHerdrComponentReceipt,
  herdrComponentReceipt,
  herdrShutdownMessage,
  type HerdrComponentShutdownReceipt,
  type HerdrShutdownCause,
  validateHerdrShutdownTimeout,
} from "./shutdown";
import {
  parseCliEnvelope,
  parseCreateIds,
  parsePaneGet,
  parsePaneList,
  parseProcessInfo,
  parseSessionList,
  parseTabList,
  parseWorkspaceList,
  type HerdrPaneRow,
  type HerdrProcessInfo,
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
  readonly workspaceLabel?: string;
  readonly tabLabel?: string;
  readonly processes?: ReadonlyArray<HerdrProcessInfo>;
}

export type HerdrRunner = (
  hostId: string,
  args: ReadonlyArray<string>,
  session?: string | null,
  timeoutMs?: number,
  route?: HerdrServerRoute,
) => Promise<CliResult>;

export type HerdrServerStarter = (
  hostId: string,
  session?: string | null,
  route?: HerdrServerRoute,
) => Promise<CliResult>;

export interface HerdrServiceOptions {
  readonly shutdownDrainTimeoutMs?: number;
}

const unavailableServerStarter: HerdrServerStarter = async () => ({
  ok: false,
  stdout: "",
  error: "herdr server starter is not configured",
});

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

/** Captures the route that a host id resolved to when a startup flight began. */
const captureServerRoute = (hostId: string): HerdrServerRoute | undefined => {
  const host = findHostById(hostId);
  if (!host) return undefined;
  return Object.freeze({
    hostId,
    kind: host.kind,
    endpoint: host.kind === "remote" ? host.endpoint ?? null : null,
  });
};

const serverRouteKey = (route: HerdrServerRoute, session: string | null): string =>
  JSON.stringify([route.hostId, route.kind, route.endpoint, session]);

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

/** Injectable mirror lookup (tests supply fakes; prod uses the registry). */
export type HerdrMirrorProvider = (hostId: string) => HerdrMirrorReads | undefined;

export class HerdrService {
  /** One startup/status path per host session; completed flights are never cached. */
  private readonly serverEnsures = new Map<
    string,
    Promise<HerdrResult<{ readonly running: boolean; readonly started: boolean }>>
  >();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly shutdownFailures: HerdrShutdownCause[] = [];
  private readonly shutdownDrainTimeoutMs: number;
  private shuttingDown = false;
  private drainFlight: Promise<HerdrComponentShutdownReceipt> | undefined;
  private cleanShutdownReceipt: HerdrComponentShutdownReceipt | undefined;

  constructor(
    private readonly rawRunner: HerdrRunner,
    private readonly mirrors: HerdrMirrorProvider = () => undefined,
    private readonly rawStartServer: HerdrServerStarter = unavailableServerStarter,
    opts: HerdrServiceOptions = {},
  ) {
    this.shutdownDrainTimeoutMs = validateHerdrShutdownTimeout(
      opts.shutdownDrainTimeoutMs,
      2_000,
    );
  }

  private readonly runner: HerdrRunner = (...args) => {
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        stdout: "",
        error: "Herdr service is shutting down",
      });
    }
    return this.trackOperation("herdr-command-failed", () => this.rawRunner(...args));
  };

  private readonly startServer: HerdrServerStarter = (...args) => {
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        stdout: "",
        error: "Herdr service is shutting down",
      });
    }
    return this.trackOperation("herdr-server-start-failed", () => this.rawStartServer(...args));
  };

  private trackOperation<T>(code: string, start: () => Promise<T>): Promise<T> {
    let flight: Promise<T>;
    try {
      flight = Promise.resolve(start());
    } catch (error) {
      flight = Promise.reject(error);
    }
    this.activeOperations.add(flight);
    void flight.then(
      () => {
        this.activeOperations.delete(flight);
      },
      (error) => {
        this.activeOperations.delete(flight);
        if (this.shuttingDown) {
          this.shutdownFailures.push({ code, message: herdrShutdownMessage(error) });
        }
      },
    );
    return flight;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  drainOnQuit(): Promise<HerdrComponentShutdownReceipt> {
    this.beginShutdown();
    if (this.cleanShutdownReceipt) return Promise.resolve(this.cleanShutdownReceipt);
    if (this.drainFlight) return this.drainFlight;
    const flight = (async (): Promise<HerdrComponentShutdownReceipt> => {
      const pending = (): ReadonlyArray<Promise<unknown>> => [
        ...new Set<Promise<unknown>>([
          ...this.activeOperations,
          ...this.serverEnsures.values(),
        ]),
      ];
      const settled = await awaitHerdrPromiseFixedPoint(
        pending,
        this.shutdownDrainTimeoutMs,
      );
      const retained = pending().length;
      const causes = [...this.shutdownFailures];
      if (!settled || retained > 0) {
        causes.push({
          code: "herdr-service-operation-retained",
          message: `${retained} Herdr service operation(s) did not settle before shutdown timeout`,
        });
      }
      const receipt = retained === 0 && causes.length === 0
        ? cleanHerdrComponentReceipt()
        : herdrComponentReceipt(retained, causes);
      if (receipt.clean) this.cleanShutdownReceipt = receipt;
      return receipt;
    })();
    this.drainFlight = flight;
    void flight.finally(() => {
      if (this.drainFlight === flight) this.drainFlight = undefined;
    });
    return flight;
  }

  /** Mirror serves list/record reads only for the default session and only while fresh. */
  private mirrorIfFresh(hostId: string, session?: string | null): HerdrMirrorReads | undefined {
    if (this.shuttingDown) return undefined;
    if (session) return undefined; // named sessions are separate servers — exec path
    const mirror = this.mirrors(hostId);
    return mirror?.isFresh() ? mirror : undefined;
  }

  /**
   * Default-session mirror even when eventsLive is false. Focus pointers and
   * last-known rows survive the reconnect window; only isFresh() list reads
   * must not be served stale. Named sessions stay exec-only.
   */
  private mirrorIfKnown(hostId: string, session?: string | null): HerdrMirrorReads | undefined {
    if (this.shuttingDown) return undefined;
    if (session) return undefined;
    return this.mirrors(hostId);
  }

  hosts(): ReadonlyArray<HerdrHostDef> {
    return listHerdrHosts();
  }

  ensureServer(
    hostId: string,
    session?: string | null,
  ): Promise<HerdrResult<{ readonly running: boolean; readonly started: boolean }>> {
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        code: "failed",
        message: "Herdr service is shutting down",
      });
    }
    const bad = requireHost(hostId);
    if (bad) return Promise.resolve(bad);
    const normalizedSession = session || null;
    const route = captureServerRoute(hostId);
    if (!route) return Promise.resolve({ ok: false, code: "invalid", message: `unknown herdr host: ${hostId}` });
    // A fresh mirror is itself live proof the server is running.
    if (this.mirrorIfFresh(hostId, normalizedSession)) {
      return Promise.resolve({ ok: true, data: { running: true, started: false } });
    }

    const key = serverRouteKey(route, normalizedSession);
    const existing = this.serverEnsures.get(key);
    if (existing) return existing;

    const flight = this.ensureServerOnce(route, normalizedSession);
    this.serverEnsures.set(key, flight);
    const clear = () => {
      if (this.serverEnsures.get(key) === flight) this.serverEnsures.delete(key);
    };
    void flight.then(clear, clear);
    return flight;
  }

  private async ensureServerOnce(
    route: HerdrServerRoute,
    session?: string | null,
  ): Promise<HerdrResult<{ readonly running: boolean; readonly started: boolean }>> {
    const { hostId } = route;
    // status is cheap; if server is up we're done.
    let status: CliResult;
    try {
      status = await this.runner(hostId, ["status", "--json"], session, 8_000, route);
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

    // The injected starter owns local detach or remote SSH daemon handoff and
    // returns only after the same bounded status probe accepts.
    try {
      const started = await this.startServer(hostId, session, route);
      if (!started.ok) return mapCliFailure(started, hostId);
      return { ok: true, data: { running: true, started: true } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "failed", message: `failed to spawn herdr server on ${hostId}: ${message}` };
    }
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
    const bad = requireHost(hostId);
    if (bad) return bad;
    const mirror = this.mirrorIfFresh(hostId, session);
    const mirrored = mirror?.listWorkspaces();
    if (mirrored) return { ok: true, data: parseWorkspaceList({ workspaces: mirrored }) };
    const res = await runEnvelope(this.runner, hostId, ["workspace", "list"], session);
    if (!res.ok) return res;
    return { ok: true, data: parseWorkspaceList(res.data) };
  }

  async listTabs(
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ): Promise<HerdrResult<ReadonlyArray<HerdrTabRow>>> {
    const bad = requireHost(hostId);
    if (bad) return bad;
    const mirror = this.mirrorIfFresh(hostId, session);
    const mirrored = mirror?.listTabs(workspaceId);
    if (mirrored) return { ok: true, data: parseTabList({ tabs: mirrored }) };
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
    const bad = requireHost(hostId);
    if (bad) return bad;
    const mirror = this.mirrorIfFresh(hostId, session);
    const mirrored = mirror?.listPanes(workspaceId);
    if (mirrored) return { ok: true, data: parsePaneList({ panes: mirrored }) };
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
    const bad = requireHost(hostId);
    if (bad) return bad;
    const mirror = this.mirrorIfFresh(hostId, session);
    const mirrored = mirror?.listAgents();
    if (mirrored) return { ok: true, data: parsePaneList({ panes: mirrored }) };
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
    const bad = requireHost(hostId);
    if (bad) return bad;

    // Mirror-served pane record drops the `pane get` round trip entirely.
    // List/record reads require isFresh(); focus pointer uses last-known
    // (mirrorIfKnown) so reconnect windows do not reintroduce row-flag thrash.
    const mirror = this.mirrorIfFresh(hostId, session);
    const known = this.mirrorIfKnown(hostId, session);
    const mirroredRecord = mirror?.paneRecord(paneId);
    let pane = mirroredRecord ? parsePaneGet({ pane: mirroredRecord }) : undefined;
    if (!pane) {
      const res = await runEnvelope(this.runner, hostId, ["pane", "get", paneId], session);
      if (!res.ok) return res;
      pane = parsePaneGet(res.data);
      if (!pane) return { ok: false, code: "not_found", message: `pane ${paneId} not found` };
    }

    // Canonical focus is focused_pane_id / pane.focused events — not the per-row
    // `focused` boolean (live herdr ships them incoherent). Prefer last-known
    // pointer even while eventsLive is false; only fall back to the row flag
    // when we have never bootstrapped a mirror for this host/session.
    const focusedFromMirror = known?.focused().paneId;
    const focused =
      focusedFromMirror !== undefined ? focusedFromMirror === paneId : pane.focused;

    // Human labels for the breadcrumb — best-effort, never blocks meta.
    // Goes through the mirror-aware list methods: a fresh mirror serves them
    // from memory, so this stays inside the no-exec discipline.
    let workspaceLabel: string | undefined;
    let tabLabel: string | undefined;
    if (pane.workspaceId) {
      const workspaces = await this.listWorkspaces(hostId, session);
      if (workspaces.ok) {
        workspaceLabel = workspaces.data.find(
          (workspace) => workspace.workspaceId === pane.workspaceId,
        )?.label;
      }
      if (pane.tabId) {
        const tabs = await this.listTabs(hostId, session, pane.workspaceId);
        if (tabs.ok) {
          tabLabel = tabs.data.find((tab) => tab.tabId === pane.tabId)?.label;
        }
      }
    }

    // Fresh mirror path is pure local memory — no pane read execs. N cards
    // re-refreshing on every agent_status_changed must not fan out N herdr
    // CLI calls (fleet flash + host burn).
    if (mirroredRecord) {
      return { ok: true, data: { ...pane, focused, workspaceLabel, tabLabel } };
    }

    // Exec fallback: cheap preview — non-blocking failure.
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

    // Foreground processes: exec-only and expensive. Mirror path never has
    // them; client merge sticky-keeps the last list so inspector PROCESS does
    // not flash empty on every fresh-mirror tick after a stale exec.
    let processes: ReadonlyArray<HerdrProcessInfo> | undefined;
    const processInfo = await runEnvelope(
      this.runner,
      hostId,
      ["pane", "process-info", "--pane", paneId],
      session,
      6_000,
    );
    if (processInfo.ok) {
      const parsed = parseProcessInfo(processInfo.data).slice(0, 3);
      if (parsed.length > 0) processes = parsed;
    }

    // Local herdr panes: bind foreground PIDs for process-bind identity.
    // Remote panes never enter the map (peer PID is always local).
    if (hostId === "local" && processes !== undefined && processes.length > 0) {
      const map = getProcessIdentityMap();
      map.unbindHerdrPane(paneId);
      for (const proc of processes) {
        if (typeof proc.pid === "number" && Number.isInteger(proc.pid) && proc.pid > 0) {
          map.bind(proc.pid, { kind: "herdr", paneId });
        }
      }
    }

    return {
      ok: true,
      data: { ...pane, focused, preview, workspaceLabel, tabLabel, processes },
    };
  }

  /**
   * Mark a pane "seen" so herdr transitions agent_status done → idle
   * (Idle+!seen → Idle+seen). Stock CLI: `herdr agent focus <pane_id>`.
   * Fire-and-forget safe — never required for control attach. Host surfaces
   * status via subscription poll; mirror applyEvent (wire-normalized) patches
   * agent_status for cards (VL-030).
   */
  async markPaneSeen(
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ): Promise<HerdrResult<{ readonly agentStatus?: string; readonly paneId: string }>> {
    if (!paneId) return { ok: false, code: "invalid", message: "paneId required" };
    const res = await runEnvelope(this.runner, hostId, ["agent", "focus", paneId], session);
    if (!res.ok) return res;
    // agent focus returns { type: "agent_info", agent: { pane_id, agent_status, … } }
    const root = res.data && typeof res.data === "object" ? (res.data as Record<string, unknown>) : {};
    const agent =
      root.agent && typeof root.agent === "object"
        ? (root.agent as Record<string, unknown>)
        : root;
    const status =
      typeof agent.agent_status === "string"
        ? agent.agent_status
        : typeof agent.agentStatus === "string"
          ? agent.agentStatus
          : undefined;
    return {
      ok: true,
      data: { paneId, agentStatus: status },
    };
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
    if (hostId === "local") {
      getProcessIdentityMap().unbindHerdrPane(paneId);
    }
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
