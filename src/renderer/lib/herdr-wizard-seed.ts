// Apply region herdr spawn defaults into the attach wizard.
// Fail-loud: missing workspace/tab on the host surfaces an error and stops
// at the broken step — never invents ids.

import type { EtherRegionHerdrDefaults } from "@shared/canvas";
import type {
  HerdrHostInfo,
  HerdrPaneInfo,
  HerdrSessionInfo,
  HerdrTabInfo,
  HerdrWorkspaceInfo,
} from "@shared/ipc";

export type HerdrWizardStep = "host" | "session" | "workspace" | "tab" | "pane";

export type HerdrWizardApi = {
  herdrHosts: () => Promise<ReadonlyArray<HerdrHostInfo>>;
  herdrEnsureServer: (
    hostId: string,
    session?: string | null,
  ) => Promise<{ ok: boolean; message?: string }>;
  herdrListSessions: (
    hostId: string,
  ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrSessionInfo>; message?: string }>;
  herdrListWorkspaces: (
    hostId: string,
    session?: string | null,
  ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrWorkspaceInfo>; message?: string }>;
  herdrListTabs: (
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrTabInfo>; message?: string }>;
  herdrListPanes: (
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ) => Promise<{ ok: boolean; data?: ReadonlyArray<HerdrPaneInfo>; message?: string }>;
};

export type HerdrWizardSeedResult = {
  readonly hosts: ReadonlyArray<HerdrHostInfo>;
  readonly sessions: ReadonlyArray<HerdrSessionInfo>;
  readonly workspaces: ReadonlyArray<HerdrWorkspaceInfo>;
  readonly tabs: ReadonlyArray<HerdrTabInfo>;
  readonly panes: ReadonlyArray<HerdrPaneInfo>;
  readonly hostId: string;
  readonly session: string | null;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly step: HerdrWizardStep;
  readonly seedApplied: boolean;
  readonly error?: string;
};

const emptyResult = (hosts: ReadonlyArray<HerdrHostInfo> = []): HerdrWizardSeedResult => ({
  hosts,
  sessions: [],
  workspaces: [],
  tabs: [],
  panes: [],
  hostId: "",
  session: null,
  workspaceId: "",
  tabId: "",
  step: "host",
  seedApplied: false,
});

/**
 * Load hosts, then optionally advance through region seed layers.
 * Returns a full wizard snapshot; callers set React state from it.
 */
export const bootstrapHerdrWizard = async (
  api: HerdrWizardApi,
  seed: EtherRegionHerdrDefaults | null | undefined,
): Promise<HerdrWizardSeedResult> => {
  const hosts = await api.herdrHosts();
  if (!seed?.host?.trim()) return emptyResult(hosts);

  const host = seed.host.trim();
  const ensuredHost = await api.herdrEnsureServer(host, null);
  if (!ensuredHost.ok) {
    return {
      ...emptyResult(hosts),
      error: ensuredHost.message ?? `region host unavailable: ${host}`,
    };
  }

  const sessList = await api.herdrListSessions(host);
  const sessions = sessList.ok ? sessList.data ?? [] : [];
  const base: HerdrWizardSeedResult = {
    ...emptyResult(hosts),
    hosts,
    sessions,
    hostId: host,
    seedApplied: true,
    step: "session",
  };

  if (seed.session === undefined) return base;

  const sess = seed.session;
  const ensuredSess = await api.herdrEnsureServer(host, sess);
  if (!ensuredSess.ok) {
    return {
      ...base,
      error: ensuredSess.message ?? "region session unavailable",
      step: "session",
    };
  }

  const wsList = await api.herdrListWorkspaces(host, sess);
  if (!wsList.ok) {
    return {
      ...base,
      session: sess,
      error: wsList.message ?? "list workspaces failed",
      step: "workspace",
    };
  }
  const workspaces = wsList.data ?? [];
  const withSession: HerdrWizardSeedResult = {
    ...base,
    session: sess,
    workspaces,
    step: "workspace",
  };

  if (!seed.workspaceId?.trim()) return withSession;

  const ws = seed.workspaceId.trim();
  if (!workspaces.some((w) => w.workspaceId === ws)) {
    return {
      ...withSession,
      error: `region workspace missing on host: ${ws}`,
      step: "workspace",
    };
  }

  const tabList = await api.herdrListTabs(host, sess, ws);
  if (!tabList.ok) {
    return {
      ...withSession,
      workspaceId: ws,
      error: tabList.message ?? "list tabs failed",
      step: "tab",
    };
  }
  const tabs = tabList.data ?? [];
  const withWorkspace: HerdrWizardSeedResult = {
    ...withSession,
    workspaceId: ws,
    tabs,
    step: "tab",
  };

  if (!seed.tabId?.trim()) return withWorkspace;

  const tab = seed.tabId.trim();
  if (!tabs.some((t) => t.tabId === tab)) {
    return {
      ...withWorkspace,
      error: `region tab missing: ${tab}`,
      step: "tab",
    };
  }

  const paneList = await api.herdrListPanes(host, sess, ws);
  if (!paneList.ok) {
    return {
      ...withWorkspace,
      tabId: tab,
      error: paneList.message ?? "list panes failed",
      step: "pane",
    };
  }
  const allPanes = paneList.data ?? [];
  const scoped = allPanes.filter((p) => !p.tabId || p.tabId === tab);
  return {
    ...withWorkspace,
    tabId: tab,
    panes: scoped.length > 0 ? scoped : allPanes,
    step: "pane",
  };
};
