import { observable } from "@legendapp/state";
import { createContext } from "react";

/** The statuses a node says (docs/node-card-language.md). Idle says nothing. */
export type NodeStatus = "blocked" | "needs-you" | "working" | "failed" | "off" | "retired";

/** Each status as a word: the tag shows it, the screen reader says it. */
export const NODE_STATUS_WORD: { readonly [S in NodeStatus]: string } = {
  blocked: "Blocked",
  "needs-you": "Needs you",
  working: "Working",
  failed: "Failed",
  off: "Off",
  retired: "Retired",
};

/** What every card shows as its status tag, by node id, so the node's spoken name can say it too. */
export const nodeStatus$ = observable<Record<string, NodeStatus>>({});

export const publishNodeStatus = (nodeId: string, status: NodeStatus | undefined): void => {
  if (nodeStatus$[nodeId].peek() === status) return;
  if (status === undefined) nodeStatus$[nodeId].delete();
  else nodeStatus$[nodeId].set(status);
};

/**
 * What a card says it is when its kind word is not enough: "seat on studio"
 * for a peer, "page copy on studio" for a stub. Read in place of the kind.
 */
export const nodeSpokenKind$ = observable<Record<string, string>>({});

export const publishNodeSpokenKind = (nodeId: string, spoken: string | undefined): void => {
  if (nodeSpokenKind$[nodeId].peek() === spoken) return;
  if (spoken === undefined) nodeSpokenKind$[nodeId].delete();
  else nodeSpokenKind$[nodeId].set(spoken);
};

/** The id of the node a card is drawn in, provided by NodeShell. "" outside a node. */
export const NodeIdContext = createContext("");

/** The execution graph holds the node blocked, provided by NodeShell. */
export const NodeBlockedContext = createContext(false);

/**
 * The status a node shows: the graph's blocked outranks a calmer status the
 * card reports (working, off, retired, or none), never failed or needs-you.
 */
export const shownStatus = (status: NodeStatus | undefined, graphBlocked: boolean): NodeStatus | undefined =>
  graphBlocked && status !== "failed" && status !== "needs-you" ? "blocked" : status;
