import type { NodeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { DIM, HUE, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};

export function LinkNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const url = node.type === "link" ? node.url : "";
  const host = hostOf(url);
  const rest = url.replace(/^https?:\/\/[^/]+/, "");

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked}>
      <div className="flex h-full items-start gap-2">
        <Link2 size={15} className="mt-0.5 shrink-0" style={{ color: HUE.cyan }} />
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold underline decoration-dotted underline-offset-2"
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {host}
          </div>
          {rest && rest !== "/" ? (
            <div
              className="truncate text-[10px]"
              style={{ color: DIM, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            >
              {rest}
            </div>
          ) : null}
        </div>
      </div>
    </NodeShell>
  );
}
