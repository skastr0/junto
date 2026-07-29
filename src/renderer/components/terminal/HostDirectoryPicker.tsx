import { useEffect, useState, type CSSProperties } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ArrowUp, RefreshCw } from "lucide-react";
import type { HostDirectorySnapshot } from "@shared/host-directory";
import { getVellumApi } from "../../lib/vellum-api";
import { Button, IconButton, Input } from "../ui";

const TREE_STYLE = {
  height: "220px",
  "--trees-bg-override": "#0d0e0d",
  "--trees-bg-muted-override": "#171816",
  "--trees-fg-override": "#d9d4c8",
  "--trees-fg-muted-override": "#77736a",
  "--trees-accent-override": "#39c6d6",
  "--trees-border-color-override": "#30312d",
  "--trees-selected-bg-override": "#27251f",
  "--trees-font-family-override":
    '"SFMono-Regular", "Cascadia Code", "Roboto Mono", monospace',
  "--trees-font-size-override": "11px",
  "--trees-density-override": "0.85",
} as CSSProperties;

function DirectoryPageTree({
  snapshot,
  onOpen,
}: {
  readonly snapshot: HostDirectorySnapshot;
  readonly onOpen: (path: string) => void;
}) {
  const paths = snapshot.entries.map((entry) =>
    `${entry.name}${entry.kind === "directory" ? "/" : ""}`
  );
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    onSelectionChange: (selectedPaths) => {
      const selected = selectedPaths.at(-1);
      if (!selected) return;
      const entry = snapshot.entries.find((candidate) =>
        candidate.name === selected
      );
      if (entry?.kind === "directory") onOpen(entry.path);
    },
    unsafeCSS: `
      :host { color-scheme: dark; }
      button[data-type='item'] { border-radius: 4px; }
    `,
  });

  return (
    <FileTree
      model={model}
      aria-label={`Folders in ${snapshot.root}`}
      style={TREE_STYLE}
    />
  );
}

export function HostDirectoryPicker({
  hostId,
  initialPath,
  onSelect,
}: {
  readonly hostId: string;
  readonly initialPath?: string;
  readonly onSelect: (path: string) => void;
}) {
  const [draft, setDraft] = useState(initialPath?.trim() || "~");
  const [snapshot, setSnapshot] = useState<HostDirectorySnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (path: string) => {
    const api = getVellumApi();
    if (!api?.hostDirectoryRead) {
      setError("Host filesystem browser is unavailable.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await api.hostDirectoryRead(hostId, path.trim() || "~");
      setSnapshot(next);
      setDraft(next.root);
      onSelect(next.root);
    } catch (reason) {
      setSnapshot(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(initialPath?.trim() || "~");
    // This component is keyed by host + inherited seed. Navigation is local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid min-h-0 gap-2 normal-case tracking-normal">
      <form
        className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void load(draft);
        }}
      >
        <Input
          aria-label="Agent working directory"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="~/Projects/project"
          onChange={(event) => setDraft(event.target.value)}
        />
        <IconButton
          type="button"
          aria-label="Open parent directory"
          title="Parent directory"
          disabled={loading || snapshot?.parent === undefined}
          onClick={() => {
            if (snapshot?.parent) void load(snapshot.parent);
          }}
        >
          <ArrowUp size={14} />
        </IconButton>
        <IconButton
          type="submit"
          aria-label="Open directory"
          title="Open directory"
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
        </IconButton>
      </form>

      <div className="min-h-[160px] overflow-hidden rounded-[5px] border border-stroke bg-inset">
        {loading && !snapshot ? (
          <div role="status" className="px-3 py-6 text-center text-[11px] text-dim">
            Reading {hostId}…
          </div>
        ) : null}
        {!loading && error ? (
          <div role="alert" className="px-3 py-6 text-center text-[11px] text-crimson">
            {error}
          </div>
        ) : null}
        {snapshot ? (
          <DirectoryPageTree
            key={snapshot.root}
            snapshot={snapshot}
            onOpen={(path) => void load(path)}
          />
        ) : null}
        {!loading && !error && snapshot?.entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-dim">Empty folder</div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 text-[10px] text-dim">
        <span className="min-w-0 truncate font-mono">{snapshot?.root ?? draft}</span>
        <Button
          type="button"
          size="xs"
          variant="subtle"
          disabled={!snapshot || loading}
          onClick={() => {
            if (snapshot) onSelect(snapshot.root);
          }}
        >
          use this folder
        </Button>
      </div>
    </div>
  );
}
