// Parse herdr CLI JSON envelopes (`{ id, result }` / `{ id, error }`) and
// hierarchy list shapes without depending on a live server.

export interface CliEnvelopeOk {
  readonly ok: true;
  readonly result: unknown;
}

export interface CliEnvelopeErr {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type CliEnvelope = CliEnvelopeOk | CliEnvelopeErr;

export const parseCliEnvelope = (stdout: string): CliEnvelope => {
  const text = stdout.trim();
  if (!text) return { ok: false, code: "empty", message: "herdr returned empty output" };
  // CLI may emit multiple NDJSON lines; take the last object with result/error.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let last: unknown;
  for (const line of lines) {
    try {
      last = JSON.parse(line);
    } catch {
      // keep scanning
    }
  }
  if (last === undefined) {
    try {
      last = JSON.parse(text);
    } catch {
      return { ok: false, code: "parse", message: `herdr non-JSON: ${text.slice(0, 200)}` };
    }
  }
  if (!last || typeof last !== "object") {
    return { ok: false, code: "parse", message: "herdr envelope is not an object" };
  }
  const obj = last as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    return {
      ok: false,
      code: typeof err.code === "string" ? err.code : "error",
      message: typeof err.message === "string" ? err.message : "herdr error",
    };
  }
  if ("result" in obj) return { ok: true, result: obj.result };
  // Some commands may return the body bare.
  return { ok: true, result: last };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export interface HerdrSessionRow {
  readonly name: string;
  readonly default?: boolean;
  readonly running?: boolean;
}

export interface HerdrWorkspaceRow {
  readonly workspaceId: string;
  readonly label?: string;
  readonly tabCount?: number;
  readonly paneCount?: number;
  readonly agentStatus?: string;
}

export interface HerdrTabRow {
  readonly tabId: string;
  readonly workspaceId?: string;
  readonly label?: string;
  readonly paneCount?: number;
  readonly agentStatus?: string;
}

export interface HerdrPaneRow {
  readonly paneId: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly terminalId?: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly agentStatus?: string;
  readonly label?: string;
  readonly focused?: boolean;
}

export const parseSessionList = (result: unknown): ReadonlyArray<HerdrSessionRow> => {
  const root = asRecord(result);
  const sessions = (root?.sessions ?? result) as unknown;
  if (!Array.isArray(sessions)) return [];
  return sessions
    .map((row): HerdrSessionRow | null => {
      const r = asRecord(row);
      if (!r) return null;
      const name = str(r.name);
      if (!name) return null;
      return {
        name,
        default: typeof r.default === "boolean" ? r.default : undefined,
        running: typeof r.running === "boolean" ? r.running : undefined,
      };
    })
    .filter((row): row is HerdrSessionRow => row !== null);
};

export const parseWorkspaceList = (result: unknown): ReadonlyArray<HerdrWorkspaceRow> => {
  const root = asRecord(result);
  const workspaces = (root?.workspaces ?? (root?.type === "workspace_list" ? root.workspaces : undefined)) as unknown;
  const list = Array.isArray(workspaces) ? workspaces : Array.isArray(result) ? result : [];
  return list
    .map((row): HerdrWorkspaceRow | null => {
      const r = asRecord(row);
      if (!r) return null;
      const workspaceId = str(r.workspace_id) ?? str(r.workspaceId);
      if (!workspaceId) return null;
      return {
        workspaceId,
        label: str(r.label),
        tabCount: typeof r.tab_count === "number" ? r.tab_count : undefined,
        paneCount: typeof r.pane_count === "number" ? r.pane_count : undefined,
        agentStatus: str(r.agent_status) ?? str(r.agentStatus),
      };
    })
    .filter((row): row is HerdrWorkspaceRow => row !== null);
};

export const parseTabList = (result: unknown): ReadonlyArray<HerdrTabRow> => {
  const root = asRecord(result);
  const tabs = (root?.tabs ?? result) as unknown;
  const list = Array.isArray(tabs) ? tabs : [];
  return list
    .map((row): HerdrTabRow | null => {
      const r = asRecord(row);
      if (!r) return null;
      const tabId = str(r.tab_id) ?? str(r.tabId);
      if (!tabId) return null;
      return {
        tabId,
        workspaceId: str(r.workspace_id) ?? str(r.workspaceId),
        label: str(r.label),
        paneCount: typeof r.pane_count === "number" ? r.pane_count : undefined,
        agentStatus: str(r.agent_status) ?? str(r.agentStatus),
      };
    })
    .filter((row): row is HerdrTabRow => row !== null);
};

export const parsePaneList = (result: unknown): ReadonlyArray<HerdrPaneRow> => {
  const root = asRecord(result);
  const panes = (root?.panes ?? result) as unknown;
  const list = Array.isArray(panes) ? panes : [];
  return list
    .map((row): HerdrPaneRow | null => {
      const r = asRecord(row);
      if (!r) return null;
      const paneId = str(r.pane_id) ?? str(r.paneId);
      if (!paneId) return null;
      return {
        paneId,
        workspaceId: str(r.workspace_id) ?? str(r.workspaceId),
        tabId: str(r.tab_id) ?? str(r.tabId),
        terminalId: str(r.terminal_id) ?? str(r.terminalId),
        cwd: str(r.cwd) ?? str(r.foreground_cwd),
        agent: str(r.agent),
        agentStatus: str(r.agent_status) ?? str(r.agentStatus),
        label: str(r.label),
        focused: typeof r.focused === "boolean" ? r.focused : undefined,
      };
    })
    .filter((row): row is HerdrPaneRow => row !== null);
};

export const parsePaneGet = (result: unknown): HerdrPaneRow | undefined => {
  const root = asRecord(result);
  const pane = root?.pane ?? root;
  const rows = parsePaneList({ panes: [pane] });
  return rows[0];
};

export const parseCreateIds = (
  result: unknown,
): {
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly paneId?: string;
  readonly terminalId?: string;
} => {
  const root = asRecord(result) ?? {};
  const workspace = asRecord(root.workspace) ?? {};
  const tab = asRecord(root.tab) ?? {};
  const rootPane = asRecord(root.root_pane) ?? asRecord(root.pane) ?? {};
  return {
    workspaceId:
      str(workspace.workspace_id) ??
      str(root.workspace_id) ??
      str(rootPane.workspace_id),
    tabId: str(tab.tab_id) ?? str(root.tab_id) ?? str(rootPane.tab_id),
    paneId: str(rootPane.pane_id) ?? str(root.pane_id),
    terminalId: str(rootPane.terminal_id) ?? str(root.terminal_id),
  };
};
