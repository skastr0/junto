import type { Node } from "@shared/model";
import { titleOf } from "@shared/model/title";

/** The authored detail of a node, kept separate from its title and live Work. */
export const detailOf = (node: Node): string => {
  switch (node.kind) {
    case "note": case "label": return node.text.split("\n").slice(1).join(" ").trim();
    case "file": return [node.path, node.subpath].filter(Boolean).join(" ");
    case "link": case "page": return node.url;
    case "git": return node.cwd;
    case "region": return node.instruction?.trim().split("\n")[0] ?? "Spatial region";
    case "agent": return node.agentKey;
    case "peer": return node.host;
    case "terminal": return node.host;
    case "task": return node.contract?.instructions?.trim().split("\n")[0] ?? "";
    case "cron": return node.expression ?? "";
    case "requests": case "artifacts": case "board": case "pad": case "sheet": case "relay": case "watcher": return "";
  }
};

/** Search only authored identity and content; mail and live Work are separate. */
export const searchOf = (node: Node): string => [
  node.kind, titleOf(node), detailOf(node),
  node.kind === "note" || node.kind === "label" ? node.text : "",
  node.kind === "agent" ? `${node.agentKey} ${node.harness} ${node.host}` : "",
  node.kind === "task" ? node.contract?.instructions ?? "" : "",
  node.kind === "region" ? node.instruction ?? "" : "",
].join(" ").toLowerCase();
