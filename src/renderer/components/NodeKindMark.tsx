import type { CSSProperties } from "react";
import {
  Bot,
  Columns3,
  File,
  FileText,
  GitBranch,
  Globe,
  Inbox,
  Link2,
  ListTodo,
  Package,
  SquareDashed,
  SquareTerminal,
  Tag,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { Node } from "@shared/model";
import { accentColor, HUE } from "../lib/theme";

const KIND_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  terminal: SquareTerminal,
  task: ListTodo,
  requests: Inbox,
  artifacts: Package,
  automations: Workflow,
  board: Columns3,
  page: Globe,
  git: GitBranch,
  label: Tag,
};

// Each kind wears one hue from the token palette so a mixed list reads at a
// glance; a node the operator coloured wears its own colour instead.
const KIND_HUES: Record<string, string> = {
  terminal: HUE.cyan,
  task: "var(--color-green)",
  requests: HUE.violet,
  artifacts: "var(--color-green)",
  automations: HUE.indigo,
  board: HUE.violet,
  page: HUE.indigo,
  git: HUE.orange,
  label: HUE.steel,
  note: HUE.gold,
  file: HUE.steel,
  link: HUE.cyan,
};

// An uncoloured region has no hue of its own; it stays neutral, as on the map.
const NEUTRAL_HUE = "var(--color-dim)";

/** A native node's kind and colour, with no document shape or extension bag. */
export function KindMark({ node, className, iconSize = 14 }: {
  readonly node: Pick<Node, "kind" | "color">;
  readonly className: string;
  readonly iconSize?: number;
}) {
  const Icon = KIND_ICONS[node.kind] ?? (node.kind === "region" ? SquareDashed : node.kind === "file" ? File : node.kind === "link" ? Link2 : FileText);
  const hue = node.color ? accentColor(node.color) : node.kind === "region" ? NEUTRAL_HUE : KIND_HUES[node.kind] ?? HUE.steel;
  return <span className={className} data-region={node.kind === "region" ? "true" : undefined}
    style={{ "--mark-hue": hue } as CSSProperties}><Icon size={iconSize} strokeWidth={1.75} /></span>;
}
