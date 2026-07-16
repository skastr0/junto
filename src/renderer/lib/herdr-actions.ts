import type { EtherHerdr } from "@shared/canvas";
import { resolveHerdrOnDelete } from "@shared/canvas";
import { herdrDeleteAction } from "@shared/herdr";
import { getVellumApi } from "./vellum-api";
import {
  closeHerdrTerminal,
  herdr$,
  setConnectionEvent,
  setHerdrToast,
} from "./herdr-state";
import { state$ } from "./state";
import { commitDoc } from "./mutations";

export { resolveHerdrOnDelete };

const herdrApi = () =>
  getVellumApi() as
    | (ReturnType<typeof getVellumApi> & {
        herdrKillPane?: (
          hostId: string,
          session: string | null | undefined,
          paneId: string,
        ) => Promise<{ ok: boolean; message?: string }>;
        herdrKillTab?: (
          hostId: string,
          session: string | null | undefined,
          tabId: string,
        ) => Promise<{ ok: boolean; message?: string }>;
        herdrCreatePane?: (
          hostId: string,
          session: string | null | undefined,
          input: { paneId?: string; direction?: "right" | "down"; cwd?: string },
        ) => Promise<{
          ok: boolean;
          data?: { paneId: string; terminalId?: string; tabId?: string; workspaceId?: string };
          message?: string;
        }>;
        herdrEnsureServer?: (
          hostId: string,
          session?: string | null,
        ) => Promise<{ ok: boolean; message?: string }>;
      })
    | undefined;

/** Detach = remove canvas node only. Never session stop. */
export const detachHerdrNode = (nodeId: string): void => {
  void closeHerdrTerminal();
  const doc = state$.doc.peek();
  if (state$.selectedNodeId.peek() === nodeId) state$.selectedNodeId.set("");
  commitDoc({
    nodes: doc.nodes.filter((n) => n.id !== nodeId),
    edges: doc.edges.filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId),
  });
};

export const killHerdrPane = async (nodeId: string, herdr: EtherHerdr): Promise<void> => {
  const action = herdrDeleteAction({
    onDelete: herdr.onDelete,
    paneId: herdr.paneId,
    explicitKill: true,
  });
  if (action !== "kill-pane" || !herdr.paneId) {
    setHerdrToast("Kill unavailable — pane id missing");
    return;
  }
  const api = herdrApi();
  if (!api?.herdrKillPane) {
    setHerdrToast("Kill unavailable — herdr API missing");
    return;
  }
  await closeHerdrTerminal();
  const result = await api.herdrKillPane(herdr.host, herdr.session ?? null, herdr.paneId);
  if (!result.ok) {
    setHerdrToast(result.message ?? "Kill pane failed — card kept");
    return;
  }
  setConnectionEvent(nodeId, { type: "pane_closed" });
  setHerdrToast("Pane closed on host");
  detachHerdrNode(nodeId);
};

export const killHerdrTab = async (nodeId: string, herdr: EtherHerdr): Promise<void> => {
  if (!herdr.tabId) {
    setHerdrToast("Kill tab unavailable — no tab id");
    return;
  }
  const api = herdrApi();
  if (!api?.herdrKillTab) {
    setHerdrToast("Kill tab unavailable — herdr API missing");
    return;
  }
  await closeHerdrTerminal();
  const result = await api.herdrKillTab(herdr.host, herdr.session ?? null, herdr.tabId);
  if (!result.ok) {
    setHerdrToast(result.message ?? "Kill tab failed — card kept");
    return;
  }
  setHerdrToast("Tab closed on host");
  detachHerdrNode(nodeId);
};

/**
 * Handle node delete for herdr cards.
 * Default policy: detach only (remote pane keeps running).
 */
export const handleHerdrNodeDelete = async (nodeId: string): Promise<boolean> => {
  const node = state$.doc.peek().nodes.find((n) => n.id === nodeId);
  if (!node || node.ether?.entity?.kind !== "herdr" || !node.ether.herdr) return false;
  const herdr = node.ether.herdr;
  const action = herdrDeleteAction({
    onDelete: resolveHerdrOnDelete(herdr),
    paneId: herdr.paneId,
    explicitKill: false,
  });
  if (action === "kill-pane" && herdr.paneId) {
    await killHerdrPane(nodeId, herdr);
    return true;
  }
  detachHerdrNode(nodeId);
  return true;
};

/** Recreate: new pane under same host/session, rebind ids into ether.herdr. */
export const recreateHerdrPane = async (nodeId: string, herdr: EtherHerdr): Promise<void> => {
  const api = herdrApi();
  if (!api?.herdrEnsureServer) {
    setHerdrToast("Recreate unavailable");
    return;
  }
  const ensure = await api.herdrEnsureServer(herdr.host, herdr.session ?? null);
  if (!ensure.ok) {
    setHerdrToast(ensure.message ?? "ensure server failed");
    return;
  }
  // Lost panes must not split-from-missing-id. Prefer new tab under workspace
  // (herdr returns a root pane); never use the dead paneId as split base.
  const extended = api as {
    herdrCreateTab?: (
      hostId: string,
      session: string | null | undefined,
      input: { workspaceId: string; label?: string },
    ) => Promise<{
      ok: boolean;
      data?: { tabId: string; paneId?: string; terminalId?: string };
      message?: string;
    }>;
  };
  let nextIds: {
    paneId?: string;
    terminalId?: string;
    tabId?: string;
    workspaceId?: string;
  } = {};
  if (herdr.workspaceId && extended.herdrCreateTab) {
    const tab = await extended.herdrCreateTab(herdr.host, herdr.session ?? null, {
      workspaceId: herdr.workspaceId,
      label: "recreate",
    });
    if (tab.ok && tab.data?.paneId) {
      nextIds = {
        paneId: tab.data.paneId,
        terminalId: tab.data.terminalId,
        tabId: tab.data.tabId,
        workspaceId: herdr.workspaceId,
      };
    } else if (!tab.ok) {
      setHerdrToast(tab.message ?? "recreate tab failed — open attach wizard");
      setConnectionEvent(nodeId, { type: "manual_fail" });
      return;
    }
  }
  if (!nextIds.paneId) {
    setHerdrToast("recreate needs a workspace — open attach wizard to create a new pane");
    setConnectionEvent(nodeId, { type: "manual_fail" });
    return;
  }
  const doc = state$.doc.peek();
  // Never carry dead pane's terminalId — force meta resolve when create omits it.
  const nextHerdr: EtherHerdr = {
    ...herdr,
    paneId: nextIds.paneId,
    terminalId: nextIds.terminalId,
    tabId: nextIds.tabId ?? herdr.tabId,
    workspaceId: nextIds.workspaceId ?? herdr.workspaceId,
  };
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === nodeId && n.type === "text"
        ? {
            ...n,
            ether: {
              ...n.ether,
              entity: { kind: "herdr" },
              herdr: nextHerdr,
            },
          }
        : n,
    ),
  });
  setConnectionEvent(nodeId, { type: "reconnected" });
  // Keep open terminal binding in sync if this card is the active modal target.
  const open = herdr$.terminal.peek();
  if (open?.nodeId === nodeId) {
    herdr$.terminal.set({
      ...open,
      herdr: nextHerdr,
      streamId: undefined,
    });
  }
  setHerdrToast("Pane recreated and rebound");
};
