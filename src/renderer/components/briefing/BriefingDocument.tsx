import { useEffect, useRef } from "react";
import type { NodeId } from "@shared/physics/schema";
import { useBriefingMentions } from "../../lib/briefing-mentions";
import { LiveMarkdownField } from "../artifacts/lazy-editors";
import type { LiveMarkdownFieldHandle } from "../artifacts/LiveMarkdownField";
import "./briefing-document.css";

/**
 * A text seats are briefed from, written as a document (plan 0.11, 08): live
 * markdown, headings and lists drawn, `@` a seat or a page, `#` a task or an
 * artifact, `[[` an artifact. The text is the Markdown as stored, byte for
 * byte; a mention is the link `mentionLink` writes.
 *
 * `value` is what the field shows: the host's draft or what is stored. When
 * it changes other than by typing (a load, Discard, a text taken from
 * elsewhere, a file brought in) the field takes it in. A region's text
 * mentions what the region reaches; without `regionId`, anything on the
 * canvas.
 */
export function BriefingDocument({
  canvasName,
  regionId,
  value,
  readOnly = false,
  label,
  surfaceLabel,
  placeholder,
  size = "page",
  onChange,
  onRest,
}: {
  readonly canvasName: string;
  readonly regionId?: NodeId;
  readonly value: string;
  readonly readOnly?: boolean;
  readonly label: string;
  readonly surfaceLabel: string;
  readonly placeholder: string;
  /** A settings page's document, or the shorter one a region's panel holds. */
  readonly size?: "page" | "panel";
  readonly onChange?: (text: string) => void;
  readonly onRest?: (text: string) => void;
}) {
  const mentions = useBriefingMentions(canvasName, regionId);
  const field = useRef<LiveMarkdownFieldHandle>(null);
  /** What the field holds now. */
  const held = useRef(value);

  useEffect(() => {
    if (value === held.current) return;
    held.current = value;
    field.current?.replace(value);
  }, [value]);

  return (
    <div className="briefing-document" data-size={size} data-readonly={readOnly ? "true" : undefined}>
      <LiveMarkdownField
        handle={field}
        className="briefing-document__field"
        value={value}
        readOnly={readOnly}
        mentions={mentions}
        label={label}
        surfaceLabel={surfaceLabel}
        placeholder={placeholder}
        onChange={(text) => {
          held.current = text;
          onChange?.(text);
        }}
        onRest={onRest}
      />
    </div>
  );
}
