import { RtsBottomBar } from "@skastr0/vellum";
import { Crosshair } from "lucide-react";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: "var(--color-ground)", padding: 20 }}>{children}</div>
);

const placeholderMinimap = (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "grid",
      placeItems: "center",
      fontSize: 9,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: "rgba(143,163,176,0.6)",
    }}
  >
    minimap
  </div>
);

// RtsBottomBar only takes minimap/tools props — everything else (hotbar
// slots, command card, kind surface, stoppage) is read from canvas runtime
// stores this harness mounts empty, so this is the bar's real idle shell:
// no selection, no slots assigned, no stoppages.
export const EmptyShell = () => (
  <Frame>
    <RtsBottomBar minimap={placeholderMinimap} />
  </Frame>
);

export const WithTools = () => (
  <Frame>
    <RtsBottomBar
      minimap={placeholderMinimap}
      tools={
        <div className="rts-field-tools">
          <button type="button" className="rts-field-tools__fit">
            <Crosshair size={11} />
            fit
          </button>
        </div>
      }
    />
  </Frame>
);
