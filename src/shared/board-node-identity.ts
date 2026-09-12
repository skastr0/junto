import type { CanvasNode } from "./canvas";

/**
 * One Board-node identity projection for every product surface. The node text
 * is a mechanical mirror (dash-prefixed recent topic titles, rewritten on
 * every work op — see mirrorBoardText), so display never reads it.
 *
 * EtherBoard carries no authored identity field today (topics + unread only,
 * see src/shared/work-model.ts), so the kind name is the only stable
 * identity — never the mirror's "- topic title" dash lines. If an authored
 * name field ever lands on EtherBoard, read it here first, like
 * requestsNodeName reads ether.requests.name.
 */
export const boardNodeName = (_node: CanvasNode | undefined): string =>
  "board";
