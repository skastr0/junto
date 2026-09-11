import { useEffect, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { PenLine } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { Pad } from "@shared/pad";
import { DIM, INK } from "../../lib/theme";
import { themeMode$ } from "../../lib/theme-mode";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { editText } from "../../lib/mutations";
import { padIsEmpty } from "./pad-editor-model";
import { PadGlyph } from "./PadGlyph";
import { PadSvg } from "./PadSvg";
import "./pad-editor.css";

function AmberDecal({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
      {children}
    </div>
  );
}

export function PadCard({
  node,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
}) {
  const glance = node.ether?.pad;
  const shapeCount = glance?.shapeCount ?? 0;
  const unread = glance?.unreadPinCount ?? 0;
  const revision = glance?.revision ?? 0;
  const theme = use$(themeMode$);
  const canvas = use$(state$.canvasName) || "";
  const [pad, setPad] = useState<Pad | null>(null);
  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = firstLine || "pad";

  useEffect(() => {
    const api = getVellumCommandApi();
    if (!api || revision === 0) {
      setPad(null);
      return;
    }
    let cancelled = false;
    void api.workPadRead(canvas, node.id).then((result) => {
      if (cancelled || !result.ok) return;
      if (padIsEmpty(result.data.pad)) {
        setPad(null);
        return;
      }
      setPad(result.data.pad);
    });
    return () => {
      cancelled = true;
    };
  }, [canvas, node.id, revision]);

  const commitRename = (nextFirst: string) => {
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };

  return (
    <div className="factory-glance factory-glance--pad pad-card flex h-full w-full flex-col overflow-hidden" data-testid="pad-card">
      <div className="factory-glance__header flex items-center gap-2">
        <AmberDecal>
          <PenLine size={15} />
        </AmberDecal>
        <div className="min-w-0 flex-1">
          {renaming && onRenameDone ? (
            <FirstLineRenameInput
              initial={label}
              ariaLabel="Rename pad"
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : (
            <div
              className="truncate font-mono text-[14px] font-semibold leading-snug"
              style={{ color: INK }}
              title={label}
            >
              {label}
            </div>
          )}
        </div>
        <span
          className="text-[9px] tabular-nums"
          style={{ color: unread > 0 ? "var(--color-amber)" : DIM }}
          data-testid="pad-glance"
        >
          {shapeCount} {shapeCount === 1 ? "shape" : "shapes"}
          {unread > 0 ? ` - ${unread} new` : ""}
        </span>
      </div>
      <div className="pad-card__thumb mt-1.5">
        {pad ? (
          <div className="h-full w-full" data-testid="pad-card-thumb">
            <PadSvg pad={pad} theme={theme} options={{ framed: true, padding: 16 }} />
          </div>
        ) : (
          <div className="pad-card__empty">
            <PadGlyph className="pad-card__glyph" testId="pad-card-empty" />
          </div>
        )}
      </div>
    </div>
  );
}

