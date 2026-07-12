import { use$ } from "@legendapp/state/react";
import { FileDown, Plus, RefreshCw } from "lucide-react";
import type { EntitySource } from "@shared/entities";
import { state$ } from "../lib/state";
import { HUE, INK, SOURCE_HUE } from "../lib/theme";

const SOURCES: ReadonlyArray<EntitySource> = ["tower", "quasar", "booth"];

function SourceDot({ source }: { readonly source: EntitySource }) {
  const snapshots = use$(state$.snapshots);
  const bundle = snapshots.bundles.find((b) => b.source === source);
  const ok = bundle?.ok ?? false;
  const hue = ok ? SOURCE_HUE[source] : HUE.crimson;
  const when = bundle ? new Date(bundle.fetchedAt).toLocaleTimeString() : "never";
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.14em]"
      style={{ color: ok ? SOURCE_HUE[source] : "#8a8378" }}
      title={`${source} · ${ok ? "ok" : "down"} · ${when}`}
    >
      <span className="size-2 rounded-full" style={{ background: hue, opacity: ok ? 0.9 : 0.5 }} />
      {source}
    </span>
  );
}

export function TopBar({
  onOpen,
  onCreate,
  onExport,
  onRefresh,
}: {
  readonly onOpen: (name: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onExport: () => void;
  readonly onRefresh: () => void;
}) {
  const canvases = use$(state$.canvases);
  const canvasName = use$(state$.canvasName);

  return (
    <header
      className="flex items-center gap-3 border-b px-4 py-2.5"
      style={{ borderColor: "rgba(237,230,218,0.1)", background: "rgba(12,11,10,0.85)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.28em]"
          style={{ color: HUE.amber }}
        >
          vellum
        </span>
        <span className="text-[9px] uppercase tracking-[0.18em]" style={{ color: "#8a8378" }}>
          station
        </span>
      </div>

      <div className="mx-2 h-5 w-px" style={{ background: "rgba(237,230,218,0.1)" }} />

      <select
        className="h-8 rounded-md border bg-transparent px-2 text-[12px] outline-none"
        style={{ borderColor: "rgba(237,230,218,0.16)", color: INK }}
        value={canvasName}
        onChange={(e) => onOpen(e.target.value)}
      >
        {canvases.length === 0 ? <option value="">no canvases</option> : null}
        {canvases.map((c) => (
          <option key={c.name} value={c.name} style={{ background: "#131110" }}>
            {c.name}
          </option>
        ))}
      </select>

      <button
        className="grid size-8 place-items-center rounded-md border transition hover:bg-white/5"
        style={{ borderColor: "rgba(237,230,218,0.16)", color: HUE.steel }}
        title="new canvas"
        onClick={() => {
          const name = window.prompt("New canvas name")?.trim();
          if (name) onCreate(name);
        }}
      >
        <Plus size={15} />
      </button>

      <div className="ml-auto flex items-center gap-4">
        <div className="flex items-center gap-3">
          {SOURCES.map((s) => (
            <SourceDot key={s} source={s} />
          ))}
        </div>

        <button
          className="grid size-8 place-items-center rounded-md border transition hover:bg-white/5"
          style={{ borderColor: "rgba(237,230,218,0.16)", color: HUE.cyan }}
          title="refresh snapshots"
          onClick={onRefresh}
        >
          <RefreshCw size={15} />
        </button>

        <button
          className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[11px] uppercase tracking-[0.14em] transition hover:bg-white/5"
          style={{ borderColor: "rgba(232,163,61,0.35)", color: HUE.amber }}
          title="export digest"
          onClick={onExport}
        >
          <FileDown size={14} />
          digest
        </button>
      </div>
    </header>
  );
}
