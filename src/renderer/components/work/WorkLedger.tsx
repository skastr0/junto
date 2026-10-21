import { WorkPageControls } from "./WorkPageControls";
import { useArtifactItems } from "../../lib/use-work-sink";
import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { askConfirm } from "../../lib/confirm";
import {
  Archive,
  ArchiveRestore,
  Download,
  ExternalLink,
  FileBox,
  FileText,
  Image,
  Link as LinkIcon,
  Maximize2,
  MessageSquareWarning,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { Artifact, Part } from "@shared/work-model";
import type { WorkOpResult } from "@shared/ipc";
import { isArtifactArchived } from "@shared/work";
import { FocusSurface } from "../FocusSurface";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Input } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { openWorkDetail } from "../../lib/work-detail-open";
import { nodeAt } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { getJuntoApi } from "../../lib/junto-api";
import {
  artifactDeletionWarning,
  artifactSearchText,
  artifactTaskReferenceLabel,
} from "./artifact-reference";
import { ArtifactMarkdown } from "./ArtifactMarkdown";
import { ContentMedia } from "./ContentMedia";
import "./work-ledger.css";

const canvasName = (): string => state$.canvasName.peek() || "";

const runWorkMutation = <T,>(
  operation: () => Promise<WorkOpResult<T>>,
): Promise<WorkOpResult<T> | undefined> => runCanvasAuthoringOperation(operation);

const isImagePart = (part: Part): boolean => {
  if (part.kind === "content" && part.ref.mediaType.startsWith("image/")) {
    return true;
  }
  if (part.kind === "url" && part.mediaType?.startsWith("image/")) return true;
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) return true;
  return part.kind === "url" && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(part.url);
};

const imageSrc = (part: Part): string | undefined => {
  if (part.kind === "url" && isImagePart(part)) return part.url;
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) {
    return `data:${part.mediaType};base64,${part.bytesBase64}`;
  }
  return undefined;
};

const isTextMediaType = (mediaType: string | undefined): boolean => {
  if (mediaType === undefined) return false;
  const [top] = mediaType.split(";");
  const clean = top.trim().toLowerCase();
  if (clean.startsWith("text/")) return true;
  if (clean.endsWith("+json") || clean.endsWith("+xml")) return true;
  const known = new Set([
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/ecmascript",
    "application/typescript",
    "application/x-sh",
    "application/x-csh",
    "application/x-python",
    "application/x-python-code",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
  ]);
  return known.has(clean);
};

const isMarkdownMediaType = (mediaType: string | undefined): boolean => {
  if (mediaType === undefined) return false;
  const clean = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    clean === "text/markdown" ||
    clean === "application/markdown" ||
    clean === "text/x-markdown" ||
    clean === "application/x-md"
  );
};

const isMarkdownFilename = (filename: string): boolean =>
  /\.(?:md|markdown|mdown|mkdn)$/iu.test(filename.trim());

const bytesOfBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const formatBytes = (count: number): string => `${count.toLocaleString()} bytes`;

function downloadRaw(part: Extract<Part, { kind: "raw" }>, filename: string) {
  const bytes = bytesOfBase64(part.bytesBase64) as Uint8Array<ArrayBuffer>;
  const file = new Blob([bytes], { type: part.mediaType ?? "application/octet-stream" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function PartView({
  part,
  filename,
  markdown = false,
}: {
  readonly part: Part;
  readonly filename: string;
  readonly markdown?: boolean;
}) {
  const bytes = useMemo(() => {
    if (part.kind === "raw" && !isImagePart(part)) return bytesOfBase64(part.bytesBase64);
    return undefined;
  }, [part]);

  const text = useMemo(() => {
    if (part.kind !== "raw" || bytes === undefined) return undefined;
    if (part.mediaType && !isTextMediaType(part.mediaType)) return undefined;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (part.mediaType) return decoded;
      if (decoded.includes("\0")) return undefined;
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded)) return undefined;
      return decoded;
    } catch {
      return undefined;
    }
  }, [part, bytes]);

  if (part.kind === "text") {
    if (markdown) {
      return (
        <div className="work-ledger-part work-ledger-part--markdown">
          <ArtifactMarkdown source={part.text} />
        </div>
      );
    }
    return <pre className="work-ledger-part work-ledger-part--text">{part.text}</pre>;
  }
  if (part.kind === "url") {
    const src = imageSrc(part);
    if (src) {
      return (
        <a className="work-ledger-part work-ledger-part--image" href={part.url} target="_blank" rel="noreferrer">
          <img src={src} alt={filename} />
          <span>
            <LinkIcon size={12} />
            Open original
          </span>
        </a>
      );
    }
    return (
      <a className="work-ledger-part work-ledger-part--link" href={part.url} target="_blank" rel="noreferrer">
        <LinkIcon size={13} />
        <span>{part.url}</span>
      </a>
    );
  }
  if (part.kind === "raw") {
    const src = imageSrc(part);
    if (src) {
      return (
        <div className="work-ledger-part work-ledger-part--image">
          <img src={src} alt={filename} />
          <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
            <Download size={11} />
            Save
          </Button>
        </div>
      );
    }
    if (text !== undefined && bytes !== undefined) {
      return (
        <div className="work-ledger-part work-ledger-part--raw-text">
          <div className="work-ledger-part__bar">
            <FileText size={13} />
            <span className="work-ledger-part__type">{part.mediaType ?? "text"}</span>
            <span className="work-ledger-part__bytes">{formatBytes(bytes.length)}</span>
            <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
              <Download size={11} />
              Save
            </Button>
          </div>
          {markdown || isMarkdownMediaType(part.mediaType) || isMarkdownFilename(filename) ? (
            <div className="work-ledger-part__body work-ledger-part__body--markdown">
              <ArtifactMarkdown source={text} />
            </div>
          ) : (
            <pre className="work-ledger-part__body">{text}</pre>
          )}
        </div>
      );
    }
    return (
      <div className="work-ledger-part work-ledger-part--raw">
        <FileBox size={18} />
        <div>
          <strong>{part.mediaType ?? "Binary data"}</strong>
          <span>{formatBytes(bytes?.length ?? 0)}</span>
        </div>
        <Button size="xs" variant="subtle" onClick={() => downloadRaw(part, filename)}>
          <Download size={11} />
          Save
        </Button>
      </div>
    );
  }
  if (part.kind === "content") {
    return (
      <div className="work-ledger-part work-ledger-part--content">
        <ContentMedia
          contentRef={part.ref}
          alt={part.ref.displayName ?? filename}
          renderMarkdown={
            markdown ||
            isMarkdownMediaType(part.ref.mediaType) ||
            isMarkdownFilename(part.ref.displayName ?? filename)
          }
        />
      </div>
    );
  }
  return (
    <pre className="work-ledger-part work-ledger-part--data">
      {JSON.stringify(part.data, null, 2)}
    </pre>
  );
}

const artifactKind = (artifact: Artifact): "image" | "link" | "document" | "data" => {
  if (artifact.parts.some(isImagePart)) return "image";
  if (artifact.parts.some((part) => part.kind === "url")) return "link";
  if (artifact.parts.some((part) => part.kind === "text")) return "document";
  return "data";
};

const artifactIcon = {
  image: Image,
  link: LinkIcon,
  document: FileText,
  data: FileBox,
} as const;

/** Shared body for side detail + expanded focus modal. */
function ArtifactContents({
  artifact,
  bodyTestId,
}: {
  readonly artifact: Artifact;
  readonly bodyTestId?: string;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const metaEntries = Object.entries(artifact.metadata ?? {}).filter(
    ([key]) => key !== "archived" && key !== "publishedBySeatId",
  );
  return (
    <>
      <div className="artifact-focus__meta" data-testid="artifact-focus-meta">
        <span className="artifact-focus__meta-id">#{artifact.artifactId}</span>
        <span>
          {artifact.parts.length} part{artifact.parts.length === 1 ? "" : "s"}
        </span>
        {isArtifactArchived(artifact) ? (
          <Chip tone="steel">archived</Chip>
        ) : null}
      </div>
      <div
        className="artifact-focus__scroll"
        data-testid={bodyTestId ?? "artifact-focus-body"}
      >
        <section>
          <h3>Contents</h3>
          {artifact.parts.length === 0 ? (
            <p className="work-ledger-empty" data-testid="artifact-empty-parts">
              No contents
            </p>
          ) : (
            <div className="work-ledger-parts artifact-focus__parts">
              {artifact.parts.map((part, index) => {
                const filename = `${name}-${index + 1}`;
                return (
                  <PartView
                    key={index}
                    part={part}
                    filename={filename}
                    markdown={
                      part.kind === "text" ||
                      isMarkdownFilename(name) ||
                      (part.kind === "raw" && isMarkdownMediaType(part.mediaType)) ||
                      (part.kind === "content" && isMarkdownMediaType(part.ref.mediaType))
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
        {metaEntries.length > 0 ? (
          <section>
            <h3>Metadata</h3>
            <dl className="work-ledger-metadata">
              {metaEntries.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
    </>
  );
}

/**
 * Immersive reader — only opened from the expand / zoom control.
 * Default selection uses the in-library side pane, not this modal.
 */
function ArtifactFocusModal({
  artifact,
  onClose,
}: {
  readonly artifact: Artifact;
  readonly onClose: () => void;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const kind = artifactKind(artifact);
  return (
    <FocusSurface
      measure="document"
      height="immersive"
      label={name}
      onClose={onClose}
      panelClassName="artifact-focus nowheel"
    >
      <OverlayHeader
        eyebrow={`artifact - ${kind}`}
        title={name}
        status={artifactTaskReferenceLabel(artifact) ?? undefined}
        actions={
          <IconButton aria-label="Close artifact" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <ArtifactContents artifact={artifact} />
    </FocusSurface>
  );
}

/** In-library side detail (~80% of the surface). */
function ArtifactSideDetail({
  artifact,
  pending,
  onExpand,
  onArchive,
  onDelete,
  onOpenSourceTask,
}: {
  readonly artifact: Artifact;
  readonly pending: boolean;
  readonly onExpand: () => void;
  readonly onArchive: (archived: boolean) => void;
  readonly onDelete: () => void;
  /** Present when the artifact has provenance; opens the publishing task. */
  readonly onOpenSourceTask?: () => void;
}) {
  const name = artifact.name?.trim() || artifact.artifactId;
  const kind = artifactKind(artifact);
  const archived = isArtifactArchived(artifact);
  return (
    <aside
      className="work-ledger-detail work-ledger-detail--artifact"
      aria-label={`Artifact ${name}`}
      data-testid="artifact-side-detail"
    >
      <header>
        <div>
          <Chip tone="violet">{kind}</Chip>
          <h2>{name}</h2>
        </div>
        <div className="work-ledger-detail__actions">
          {onOpenSourceTask ? (
            <IconButton
              aria-label="Open source task"
              title="Open the task that published this artifact"
              onClick={onOpenSourceTask}
              disabled={pending}
            >
              <ExternalLink size={14} />
            </IconButton>
          ) : null}
          <IconButton
            aria-label="Expand artifact"
            title="Expand"
            onClick={onExpand}
            disabled={pending}
          >
            <Maximize2 size={14} />
          </IconButton>
          <IconButton
            aria-label={archived ? "Restore artifact" : "Archive artifact"}
            title={archived ? "Restore" : "Archive"}
            onClick={() => onArchive(!archived)}
            disabled={pending}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </IconButton>
          <IconButton
            aria-label="Delete artifact"
            title="Delete"
            onClick={onDelete}
            disabled={pending}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      </header>
      <ArtifactContents artifact={artifact} bodyTestId="artifact-side-body" />
    </aside>
  );
}

export function ArtifactLibrary({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const work = useArtifactItems(use$(state$.canvasName) || "", nodeId);
  const items = work.items;
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  /** Selected for the side pane (not the expand modal). First live artifact. */
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    return items.find((item) => !isArtifactArchived(item))?.artifactId ?? null;
  });
  /** Expanded immersive reader only. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const api = getJuntoApi();
  const name = canvasName();
  const normalized = query.trim().toLowerCase();
  const archivedCount = items.filter(isArtifactArchived).length;
  const liveCount = items.length - archivedCount;

  const visible = useMemo(() => {
    const base = showArchived
      ? items
      : items.filter((artifact) => !isArtifactArchived(artifact));
    if (!normalized) return base;
    return base.filter((artifact) =>
      artifactSearchText(artifact).toLowerCase().includes(normalized),
    );
  }, [items, normalized, showArchived]);

  // Selection invalidation only: a row that filters or deletes out of view
  // clears the pane. The operator always picks the next selection — the pane
  // never silently jumps to another artifact.
  useEffect(() => {
    if (selectedId && !visible.some((a) => a.artifactId === selectedId)) {
      setSelectedId(null);
    }
  }, [visible, selectedId]);

  const selected = selectedId
    ? visible.find((artifact) => artifact.artifactId === selectedId)
    : undefined;
  const expanded = expandedId
    ? items.find((artifact) => artifact.artifactId === expandedId)
    : undefined;

  // A deleted (or vanished) artifact closes the immersive reader.
  useEffect(() => {
    if (expandedId && expanded === undefined) setExpandedId(null);
  }, [expandedId, expanded]);

  const runArtifactMutation = async (
    artifactId: string,
    operation: () => Promise<WorkOpResult<unknown>>,
  ): Promise<void> => {
    if (!api) return;
    setPendingId(artifactId);
    setError("");
    try {
      const result = await runWorkMutation(operation);
      if (result === undefined) return;
      if (!result.ok) setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  };

  const archiveArtifact = (artifact: Artifact, archived: boolean): void => {
    if (!api) return;
    void runArtifactMutation(artifact.artifactId, () =>
      api.workArtifactArchive(name, nodeId, artifact.artifactId, archived),
    );
  };

  const deleteArtifact = (artifact: Artifact): void => {
    void confirmArtifactDelete(artifact).catch((error) => setError(error instanceof Error ? error.message : String(error)));
  };
  const confirmArtifactDelete = async (artifact: Artifact): Promise<void> => {
    if (!api) return;
    const label = artifact.name?.trim() || artifact.artifactId;
    const source = artifact.task;
    const sourceTask = source === undefined || source.sink.canvasName !== name ? undefined
      : await api.workItem({ ...source.sink, kind: "task", itemId: source.itemId });
    const warning = artifactDeletionWarning({
      artifact, sinkNodeId: nodeId,
      resolveTask: (ref) => ref.itemId === source?.itemId && ref.sink.nodeId === source.sink.nodeId ? sourceTask : undefined,
    });
    void askConfirm({
      source: "artifact-delete",
      title: `Delete artifact “${label}”?`,
      body: ["This cannot be undone.", ...(warning ? [warning] : [])],
      confirmLabel: "Delete artifact",
      tone: "danger",
    }).then((confirmed) => {
      if (!confirmed) return;
      // Selection/expanded cleanup happens through the invalidation effects
      // once the deletion reaches the work store — never eagerly.
      void runArtifactMutation(artifact.artifactId, () =>
        api.workArtifactDelete(name, nodeId, artifact.artifactId),
      );
    });
  };

  /** Provenance jump: close the library and open the publishing task. */
  const openSourceTask = (artifact: Artifact): void => {
    const ref = artifact.task;
    if (ref === undefined) return;
    if (ref.sink.canvasName !== name) {
      setError(
        `Source task ${ref.itemId} lives on “${ref.sink.canvasName}” — open that canvas to view it.`,
      );
      return;
    }
    const sinkNode = nodeAt(name, ref.sink.nodeId);
    if (sinkNode?.kind !== "task") {
      setError(
        `Source task ${ref.itemId} is no longer on ${ref.sink.canvasName}/${ref.sink.nodeId}.`,
      );
      return;
    }
    onClose();
    openWorkDetail(sinkNode.id, { itemId: ref.itemId });
  };

  return (
    <>
      <FocusSurface
        measure="workspace"
        height="immersive"
        label="Artifacts"
        onClose={onClose}
        closeOnEscape={expanded === undefined}
        closeOnBackdrop={expanded === undefined}
        panelClassName="work-ledger-surface work-ledger-surface--artifacts nowheel"
      >
        <OverlayHeader
          eyebrow="artifacts"
          title="Artifact library"
          status={`${liveCount} active${archivedCount > 0 ? ` - ${archivedCount} archived` : ""}`}
          actions={
            <>
              <WorkPageControls {...work} />
              <Button
                size="xs"
                variant={showArchived ? "primary" : "subtle"}
                aria-pressed={showArchived}
                data-testid="artifact-show-archived"
                onClick={() => setShowArchived((value) => !value)}
              >
                <Archive size={12} />
                {showArchived ? "Hide archived" : "Show archived"}
              </Button>
              <div className="work-ledger-search">
                <Search size={13} aria-hidden />
                <Input
                  aria-label="Search artifacts"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search artifacts"
                />
              </div>
              <IconButton aria-label="Close artifacts" title="Close" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </>
          }
        />
        {error ? (
          <div className="work-ledger-error" role="alert">
            <MessageSquareWarning size={14} />
            {error}
            <button type="button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        ) : null}
        <div
          className="work-ledger-workspace work-ledger-workspace--artifacts"
          data-detail-open={selected ? "true" : "false"}
        >
          <div className="work-ledger-list work-ledger-list--artifacts-rail">
            <section>
              <header>
                <h2>{showArchived ? "All" : "Published"}</h2>
                <span>{visible.length}</span>
              </header>
              <div role="list">
                {visible.map((artifact) => {
                  const kind = artifactKind(artifact);
                  const Icon = artifactIcon[kind];
                  const rowName = artifact.name?.trim() || artifact.artifactId;
                  const isSelected = selectedId === artifact.artifactId;
                  const archived = isArtifactArchived(artifact);
                  return (
                    <div
                      key={artifact.artifactId}
                      role="listitem"
                      className={[
                        "work-ledger-row",
                        "work-ledger-row--artifact",
                        "work-ledger-row--artifact-compact",
                        archived ? "is-archived" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-current={isSelected ? "true" : undefined}
                      data-testid="artifact-row"
                      data-artifact-id={artifact.artifactId}
                    >
                      <button
                        type="button"
                        className="work-ledger-row__select"
                        aria-label={`Select ${rowName}`}
                        onClick={() => setSelectedId(artifact.artifactId)}
                      >
                        <span className="work-ledger-row__icon">
                          <Icon size={14} />
                        </span>
                        <span>
                          <strong>{rowName}</strong>
                          <small>
                            {[
                              archived ? "archived" : undefined,
                              artifactTaskReferenceLabel(artifact),
                              `${artifact.parts.length} part${artifact.parts.length === 1 ? "" : "s"}`,
                            ]
                              .filter(Boolean)
                              .join(" - ")}
                          </small>
                        </span>
                        <Chip tone={archived ? "steel" : "violet"}>{kind}</Chip>
                      </button>
                      <button
                        type="button"
                        className="work-ledger-row__expand"
                        title="Expand"
                        aria-label={`Expand ${rowName}`}
                        data-testid="artifact-row-expand"
                        onClick={() => {
                          setSelectedId(artifact.artifactId);
                          setExpandedId(artifact.artifactId);
                        }}
                      >
                        <Maximize2 size={12} />
                      </button>
                    </div>
                  );
                })}
                {visible.length === 0 ? (
                  <div className="work-ledger-list__empty">
                    {normalized
                      ? "No matching artifacts"
                      : showArchived
                        ? "No artifacts yet"
                        : archivedCount > 0
                          ? "No active artifacts — show archived to browse"
                          : "No artifacts published yet"}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
          {selected ? (
            <ArtifactSideDetail
              key={selected.artifactId}
              artifact={selected}
              pending={pendingId === selected.artifactId}
              onExpand={() => setExpandedId(selected.artifactId)}
              onArchive={(archived) => archiveArtifact(selected, archived)}
              onDelete={() => deleteArtifact(selected)}
              onOpenSourceTask={
                selected.task ? () => openSourceTask(selected) : undefined
              }
            />
          ) : (
            <div className="work-ledger-detail work-ledger-detail--empty" aria-hidden>
              <p>Select an artifact to preview</p>
            </div>
          )}
        </div>
      </FocusSurface>

      {expanded ? (
        <ArtifactFocusModal
          key={expanded.artifactId}
          artifact={expanded}
          onClose={() => setExpandedId(null)}
        />
      ) : null}
    </>
  );
}
