import type { CSSProperties } from "react";
import {
  Bot,
  Clock,
  Columns3,
  File,
  FileText,
  GitBranch,
  Globe,
  Inbox,
  Link2,
  ListTodo,
  Package,
  PenLine,
  SquareDashed,
  SquareTerminal,
  Table,
  Tag,
  type LucideIcon,
} from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { nodeTypeLabel } from "../lib/presentation";
import { accentColor, HUE } from "../lib/theme";

const KIND_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  terminal: SquareTerminal,
  task: ListTodo,
  requests: Inbox,
  artifacts: Package,
  board: Columns3,
  pad: PenLine,
  sheet: Table,
  page: Globe,
  cron: Clock,
  relay: GitBranch,
  git: GitBranch,
  label: Tag,
};

const TYPE_ICONS: Record<string, LucideIcon> = {
  text: FileText,
  file: File,
  link: Link2,
  group: SquareDashed,
};

// Each kind wears one hue from the token palette so a mixed list reads at a
// glance; a node the operator coloured wears its own colour instead.
const KIND_HUES: Record<string, string> = {
  terminal: HUE.cyan,
  task: "var(--color-green)",
  requests: HUE.violet,
  artifacts: "var(--color-green)",
  board: HUE.violet,
  pad: HUE.orange,
  sheet: "var(--color-green)",
  page: HUE.indigo,
  cron: HUE.indigo,
  relay: HUE.orange,
  git: HUE.orange,
  label: HUE.steel,
  note: HUE.gold,
  file: HUE.steel,
  link: HUE.cyan,
};

// An uncoloured region has no hue of its own; it stays neutral, as on the map.
const NEUTRAL_HUE = "var(--color-dim)";

/** The node's hue: its own colour, else its kind's, neutral for a region. */
export const nodeMarkHue = (node: CanvasNode): string => {
  if (node.color) return accentColor(node.color);
  if (node.type === "group") return NEUTRAL_HUE;
  return KIND_HUES[nodeTypeLabel(node)] ?? HUE.steel;
};

/**
 * A node's kind as an icon in its hue, for any list of nodes that is not an
 * agent seat (a seat shows its face in its ring instead): cmd+K rows and the
 * command group chips. The caller's class draws the tile; `--mark-hue` carries
 * the hue.
 */
export function NodeKindMark({
  node,
  className,
  iconSize = 14,
}: {
  readonly node: CanvasNode;
  readonly className: string;
  readonly iconSize?: number;
}) {
  const Icon = KIND_ICONS[node.ether?.entity?.kind ?? ""] ?? TYPE_ICONS[node.type] ?? FileText;
  return (
    <span
      className={className}
      data-region={node.type === "group" ? "true" : undefined}
      style={{ "--mark-hue": nodeMarkHue(node) } as CSSProperties}
    >
      <Icon size={iconSize} strokeWidth={1.75} />
    </span>
  );
}
