import type { NodeProps } from "@xyflow/react";
import { FileText } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { DIM, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

export function FileNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const path = node.type === "file" ? node.file : "";
  const segments = path.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? path;
  const dir = segments.slice(0, -1).join("/");

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked}>
      <div className="flex h-full items-start gap-2">
        <FileText size={15} className="mt-0.5 shrink-0" style={{ color: DIM }} />
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold"
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {base}
          </div>
          {dir ? (
            <div
              className="truncate text-[10px]"
              style={{ color: DIM, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            >
              {dir}/
            </div>
          ) : null}
        </div>
      </div>
    </NodeShell>
  );
}
