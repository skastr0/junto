import type { CanvasNode } from "./canvas";
import { boardTitleFromText } from "./task";

/**
 * One Board-node identity projection for every product surface. EtherBoard
 * carries no authored name field (topics + unread only, see
 * src/shared/work-model.ts); the node text's first line is the authored
 * identity instead — mirrorBoardText keeps it as the title with dash-prefixed
 * topic lines only beneath it, and mergeBoardNodeText preserves the local
 * first line across work writes. boardTitleFromText trims it and falls back
 * to the kind name when empty.
 */
export const boardNodeName = (node: CanvasNode | undefined): string =>
  boardTitleFromText(node?.type === "text" ? node.text : "");
