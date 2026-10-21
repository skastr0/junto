import type { MentionRef } from "@shared/mention";
import type { ResourceKind } from "../../lib/resource-visuals";

/** A mention as the ResourceChip draws it: its kind, and its label without the `@` or `#` the chip adds. */
export const mentionLabelKind = (
  ref: MentionRef,
  label: string,
): { readonly kind: ResourceKind; readonly label: string; readonly number?: number } => {
  const bare = label.replace(/^[@#]/, "");
  switch (ref.kind) {
    case "seat":
      return { kind: "seat", label: bare };
    case "page":
      return { kind: "page", label: bare };
    case "task": {
      const numbered = /^(\d+)\s+(.*)$/.exec(bare);
      return numbered === null ? { kind: "task", label: bare } : { kind: "task", label: numbered[2] ?? bare, number: Number(numbered[1]) };
    }
    case "artifact":
      return { kind: "artifact", label: bare };
  }
};
