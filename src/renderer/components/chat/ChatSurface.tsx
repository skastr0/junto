import { Pin, PinOff, X } from "lucide-react";
import type { WorkSurface, WorkZone } from "../../lib/surface-registry";
import {
  closeWorkbenchSurface,
  dock$,
  pinWorkbenchSurface,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import { IconButton } from "../ui";
import { ChatView } from "./ChatView";

export function ChatSurface({
  surface,
  zone,
  visible,
  onActivate,
}: {
  readonly surface: WorkSurface;
  readonly zone: WorkZone;
  readonly visible: boolean;
  readonly onActivate: () => void;
}) {
  const payload = dock$.chatById[surface.id].peek();
  if (!payload) {
    return (
      <section className="dock-slot workbench-surface">
        <div className="workbench-surface__placeholder">ACP chat · unbound</div>
      </section>
    );
  }

  const pinned = zone === "pinned";
  const actions = (
    <>
      <IconButton
        size="md"
        aria-label={pinned ? "Unpin ACP chat" : "Pin ACP chat"}
        title={pinned ? "move to focus" : "pin to side dock"}
        onClick={() => {
          if (pinned) unpinWorkbenchSurface(surface.id);
          else pinWorkbenchSurface(surface.id);
        }}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </IconButton>
      <IconButton
        size="md"
        tone="danger"
        aria-label="Close ACP chat"
        title="close chat surface"
        onClick={() => closeWorkbenchSurface(surface.id)}
      >
        <X size={14} />
      </IconButton>
    </>
  );

  return (
    <section
      className="dock-slot dock-slot--chat workbench-surface"
      aria-label={`ACP chat · ${payload.title}`}
      aria-hidden={!visible}
      onMouseDown={onActivate}
    >
      <ChatView
        agentKey={payload.agentKey}
        displayName={payload.title}
        contextBlocks={[{ label: "Selected node", text: payload.nodeId }]}
        actions={actions}
      />
    </section>
  );
}
