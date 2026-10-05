/**
 * The region environment screen: where a region's seats get their
 * environment, on one page.
 *
 * Sources name what the operator already has (a Keychain item, a 1Password
 * reference, an env file) in the order they apply; the resolved list shows
 * what a seat started in this region would get and from where; the sealed
 * switch cuts the region off from the ones around it; folders are extra
 * directories its seats may reach.
 *
 * Every edit is saved at once: there is no draft of the whole screen to lose.
 * A secret typed into a form is sent to Junto's secret store when the source
 * is saved and dropped with the form; this screen never shows one back.
 *
 * Pure of the canvas: the environment comes in, the next one goes out, and
 * everything else is asked of the port. The modal around it does the writing.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import {
  STATUS_LABEL,
  SOURCE_KINDS,
  cleanEnvironment,
  cleanFolders,
  describeSource,
  draftOfSource,
  draftProblems,
  draftSecretValue,
  folderProblem,
  newSourceDraft,
  reorderSources,
  resolvedView,
  sourceKindSpec,
  statusReason,
  toSource,
  upsertSource,
  type EnvSource,
  type EnvSourceKind,
  type RegionEnvironment,
  type RegionEnvironmentPort,
  type ResolvedProvider,
  type SourceDraft,
  type SourceReport,
  type SourceReportStatus,
  type StaleSeat,
} from "../../lib/region-environment";
import { Button, Chip, IconButton, Input, Select, StatusDot, Switch, Textarea, type ChipTone } from "../ui";
import "./region-environment.css";

const STATUS_TONE: Readonly<Record<SourceReportStatus, ChipTone>> = {
  ok: "green",
  missing: "crimson",
  error: "crimson",
  "skipped-host": "steel",
  overridden: "steel",
};

const isFailure = (status: SourceReportStatus): boolean => status === "missing" || status === "error";

/** Where a variable comes from, in words. */
const origin = (provider: ResolvedProvider): string =>
  provider.inherited
    ? `${provider.kindLabel}, inherited from ${provider.regionLabel}`
    : `${provider.kindLabel}, this region`;

function SourceForm({
  draft,
  isNew,
  tokenSources,
  saving,
  problem,
  onChange,
  onSave,
  onCancel,
}: {
  readonly draft: SourceDraft;
  readonly isNew: boolean;
  /** Other sources that could yield the 1Password service account token. */
  readonly tokenSources: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly saving: boolean;
  readonly problem?: string;
  readonly onChange: (draft: SourceDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const spec = sourceKindSpec(draft.kind);
  const [tried, setTried] = useState(false);
  const problems = draftProblems(draft);
  const set = (key: string, value: string) => onChange({ ...draft, fields: { ...draft.fields, [key]: value } });
  const save = () => {
    setTried(true);
    if (Object.keys(problems).length === 0) onSave();
  };
  return (
    <form
      className="region-env__form"
      data-testid="region-env-form"
      data-kind={draft.kind}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {isNew ? (
        <div className="region-env__kinds" role="radiogroup" aria-label="Kind of source">
          {SOURCE_KINDS.map((kind) => (
            <button
              key={kind.kind}
              type="button"
              role="radio"
              aria-checked={kind.kind === draft.kind}
              className="region-env__kind"
              data-testid={`region-env-kind-${kind.kind}`}
              onClick={() => onChange(newSourceDraft(draft.id, kind.kind))}
            >
              <span className="region-env__kind-label">{kind.label}</span>
              <span className="region-env__kind-summary">{kind.summary}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="region-env__form-kind">
          <span className="region-env__kind-label">{spec.label}</span>
          <span className="region-env__kind-summary">{spec.summary}</span>
        </p>
      )}
      <div className="region-env__fields">
        {spec.fields.map((field) => {
          const id = `region-env-${draft.id}-${field.key}`;
          const value = draft.fields[field.key] ?? "";
          const error = tried ? problems[field.key] : undefined;
          const keepsStored = field.secret === true && draft.secretId !== undefined;
          return (
            <div key={field.key} className="region-env__field">
              <label htmlFor={id} className="region-env__label">
                {field.label}
                {field.optional ? <span className="region-env__optional">optional</span> : null}
              </label>
              {field.key === "tokenFrom" ? (
                <Select
                  aria-label={field.label}
                  value={value}
                  options={[{ value: "", label: "What op is already signed in with" }, ...tokenSources]}
                  onChange={(next) => set(field.key, next)}
                />
              ) : field.key === "attributes" ? (
                <Textarea
                  id={id}
                  dense
                  value={value}
                  placeholder={field.placeholder}
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              ) : (
                <Input
                  id={id}
                  value={value}
                  type={field.secret ? "password" : "text"}
                  // A secret is never offered back by the browser's own memory.
                  autoComplete={field.secret ? "new-password" : "off"}
                  spellCheck={false}
                  placeholder={keepsStored ? "leave empty to keep the stored value" : field.placeholder}
                  aria-invalid={error ? true : undefined}
                  data-testid={`region-env-field-${field.key}`}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              )}
              {error ? (
                <p className="region-env__error" role="alert">
                  {error}
                </p>
              ) : field.hint ? (
                <p className="region-env__hint">{field.hint}</p>
              ) : null}
            </div>
          );
        })}
        <label className="region-env__required">
          <Switch
            checked={draft.required}
            onCheckedChange={(required) => onChange({ ...draft, required })}
            aria-label="Required"
          />
          <span>
            Required
            <span className="region-env__hint">
              Off: a seat starts without it and the list below says so. On: a seat will not start without it.
            </span>
          </span>
        </label>
      </div>
      {problem ? (
        <p className="region-env__error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="region-env__form-actions">
        <Button type="button" size="sm" variant="subtle" onClick={onCancel}>
          cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={saving} data-testid="region-env-save-source">
          {isNew ? "add source" : "save source"}
        </Button>
      </div>
    </form>
  );
}

export function RegionEnvironmentScreen({
  regionId,
  environment,
  port,
  onChange,
  newId,
}: {
  readonly regionId: string;
  readonly environment: RegionEnvironment | undefined;
  readonly port: RegionEnvironmentPort;
  /** The region's next environment; undefined when nothing is left in it. */
  readonly onChange: (next: RegionEnvironment | undefined) => void;
  readonly newId: () => string;
}) {
  const sources = useMemo(() => environment?.sources ?? [], [environment]);
  const folders = environment?.folders ?? [];
  const sealed = environment?.sealed === true;

  const [draft, setDraft] = useState<SourceDraft | undefined>();
  const [saving, setSaving] = useState(false);
  const [formProblem, setFormProblem] = useState<string | undefined>();
  const [folderDraft, setFolderDraft] = useState("");
  const [dragging, setDragging] = useState<number | undefined>();
  const [report, setReport] = useState<ReadonlyArray<SourceReport> | undefined>();
  const [reportProblem, setReportProblem] = useState<string | undefined>();
  const [stale, setStale] = useState<ReadonlyArray<StaleSeat>>([]);
  const [restarting, setRestarting] = useState<string | undefined>();
  const [restartProblem, setRestartProblem] = useState<string | undefined>();

  // The resolution follows what is saved: read it again after every change.
  const saved = useMemo(() => JSON.stringify(environment ?? null), [environment]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    void port.report(regionId).then((result) => {
      if (!live) return;
      if (result.ok) {
        setReport(result.report);
        setReportProblem(undefined);
      } else {
        setReportProblem(result.message);
      }
    });
    void port.staleSeats(regionId).then((result) => {
      if (live && result.ok) setStale(result.seats);
    });
    return () => {
      live = false;
    };
  }, [port, regionId, saved, refresh]);

  const view = useMemo(() => resolvedView(report ?? [], regionId), [report, regionId]);
  const commit = (next: RegionEnvironment) => onChange(cleanEnvironment(next));
  const withSources = (next: ReadonlyArray<EnvSource>) => commit({ ...environment, sources: next });

  const saveDraft = async () => {
    if (draft === undefined) return;
    setFormProblem(undefined);
    let secretId: string | undefined;
    const secret = draftSecretValue(draft);
    if (secret !== undefined) {
      setSaving(true);
      const stored = await port.saveSecret({
        regionId,
        name: (draft.fields.name ?? "").trim(),
        value: secret,
        ...(draft.secretId ? { secretId: draft.secretId } : {}),
      });
      setSaving(false);
      if (!stored.ok) {
        setFormProblem(stored.message);
        return;
      }
      secretId = stored.secretId;
    }
    const source = toSource(draft, secretId);
    // The form goes, and the typed value with it.
    setDraft(undefined);
    withSources(upsertSource(sources, source));
  };

  const removeSource = (source: EnvSource) => {
    withSources(sources.filter((existing) => existing.id !== source.id));
    if (draft?.id === source.id) setDraft(undefined);
    // The stored secret has no other reference: it goes with its source.
    if (source.kind === "secret" && source.secretId) void port.removeSecret(source.secretId);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= sources.length || from === to) return;
    withSources(reorderSources(sources, from, to));
  };

  const addFolder = () => {
    const folder = folderDraft.trim();
    if (!folder || folderProblem(folder)) return;
    commit({ ...environment, folders: cleanFolders([...folders, folder]) });
    setFolderDraft("");
  };

  const restart = async (seat: StaleSeat) => {
    setRestarting(seat.seatId);
    setRestartProblem(undefined);
    const result = await port.restartSeat(seat.seatId);
    setRestarting(undefined);
    if (!result.ok) setRestartProblem(`${seat.title}: ${result.message}`);
    setRefresh((count) => count + 1);
  };

  const tokenSources = sources
    .filter((source) => source.id !== draft?.id && "name" in source)
    .map((source) => ({ value: source.id, label: describeSource(source).title }));
  const newFolderProblem = folderProblem(folderDraft);
  const editingNew = draft !== undefined && !sources.some((source) => source.id === draft.id);

  return (
    <div className="region-env" data-testid="region-env">
      <section className="region-env__section" aria-label="Sources">
        <header className="region-env__heading">
          <h3>Sources</h3>
          <p>Applied top to bottom. A later source wins when two set the same name.</p>
        </header>
        {sources.length === 0 && draft === undefined ? (
          <p className="region-env__empty">
            Nothing yet. Add a source to give the seats in this region a variable you already keep somewhere.
          </p>
        ) : null}
        <ol className="region-env__sources">
          {sources.map((source, index) => {
            const described = describeSource(source);
            const status = view.statusBySourceId[source.id];
            if (draft?.id === source.id) {
              return (
                <li key={source.id} className="region-env__source region-env__source--editing">
                  <SourceForm
                    draft={draft}
                    isNew={false}
                    tokenSources={tokenSources}
                    saving={saving}
                    problem={formProblem}
                    onChange={setDraft}
                    onSave={() => void saveDraft()}
                    onCancel={() => setDraft(undefined)}
                  />
                </li>
              );
            }
            return (
              <li
                key={source.id}
                className="region-env__source"
                data-testid="region-env-source"
                data-source-id={source.id}
                data-dragging={dragging === index ? "true" : undefined}
                draggable
                onDragStart={(event) => {
                  setDragging(index);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (dragging === undefined) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== undefined) move(dragging, index);
                  setDragging(undefined);
                }}
                onDragEnd={() => setDragging(undefined)}
              >
                <span className="region-env__grip" aria-hidden title="Drag to reorder">
                  <GripVertical size={14} />
                </span>
                <div className="region-env__source-text">
                  <span className="region-env__source-title">{described.title}</span>
                  <span className="region-env__source-detail">{described.detail}</span>
                  {status && isFailure(status.status) ? (
                    <span className="region-env__error" role="alert">
                      {statusReason(status)}
                    </span>
                  ) : null}
                </div>
                {source.required ? <Chip tone="amber">required</Chip> : null}
                {status ? <Chip tone={STATUS_TONE[status.status]}>{STATUS_LABEL[status.status]}</Chip> : null}
                <IconButton
                  size="sm"
                  aria-label={`Move ${described.title} up`}
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp size={12} />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label={`Move ${described.title} down`}
                  title="Move down"
                  disabled={index === sources.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown size={12} />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label={`Edit ${described.title}`}
                  title="Edit"
                  onClick={() => {
                    setFormProblem(undefined);
                    setDraft(draftOfSource(source));
                  }}
                >
                  <Pencil size={12} />
                </IconButton>
                <IconButton
                  size="sm"
                  tone="danger"
                  aria-label={`Remove ${described.title}`}
                  title="Remove"
                  onClick={() => removeSource(source)}
                >
                  <Trash2 size={12} />
                </IconButton>
              </li>
            );
          })}
        </ol>
        {editingNew && draft ? (
          <SourceForm
            draft={draft}
            isNew
            tokenSources={tokenSources}
            saving={saving}
            problem={formProblem}
            onChange={setDraft}
            onSave={() => void saveDraft()}
            onCancel={() => setDraft(undefined)}
          />
        ) : (
          <Button
            type="button"
            size="sm"
            variant="chrome"
            data-testid="region-env-add-source"
            onClick={() => {
              setFormProblem(undefined);
              setDraft(newSourceDraft(newId(), SOURCE_KINDS[0]!.kind as EnvSourceKind));
            }}
          >
            <Plus size={14} aria-hidden />
            add source
          </Button>
        )}
      </section>

      <section className="region-env__section" aria-label="What a seat here gets">
        <header className="region-env__heading">
          <h3>What a seat here gets</h3>
          <p>Names and where they come from. Values are never shown.</p>
        </header>
        {view.blocksLaunch ? (
          <p className="region-env__error" role="alert" data-testid="region-env-blocks-launch">
            A required source is failing, so seats in this region will not start until it is fixed.
          </p>
        ) : null}
        {reportProblem ? (
          <p className="region-env__error" role="alert">
            {reportProblem}
          </p>
        ) : null}
        {view.sourceErrors.map((error) => (
          <p key={`${error.regionId}:${error.sourceId}`} className="region-env__error" role="alert">
            {error.title}: {statusReason(error)}
          </p>
        ))}
        {report !== undefined && view.variables.length === 0 && view.sourceErrors.length === 0 ? (
          <p className="region-env__empty">
            {sealed
              ? "Nothing. This region is sealed and has no sources of its own."
              : "Nothing. No source here or in the regions around this one sets a variable."}
          </p>
        ) : null}
        <ul className="region-env__resolved">
          {view.variables.map((variable) => (
            <li key={variable.name} className="region-env__variable" data-testid="region-env-variable" data-name={variable.name}>
              <div className="region-env__variable-head">
                <StatusDot tone={variable.effective ? "green" : "crimson"} />
                <span className="region-env__variable-name" data-unset={variable.effective ? undefined : "true"}>
                  {variable.name}
                </span>
                {variable.effective ? (
                  <span className="region-env__origin" data-inherited={variable.effective.inherited ? "true" : undefined}>
                    {origin(variable.effective)}
                  </span>
                ) : (
                  <span className="region-env__error">not set</span>
                )}
                {variable.effective?.inherited ? <Chip tone="violet">inherited</Chip> : null}
              </div>
              {variable.failed.map((provider) => (
                <p
                  key={`${provider.regionId}:${provider.sourceId}`}
                  className={isFailure(provider.status) ? "region-env__error" : "region-env__hint"}
                  role={isFailure(provider.status) ? "alert" : undefined}
                >
                  {origin(provider)}: {statusReason(provider)}
                </p>
              ))}
              {variable.overridden.map((provider) => (
                <p key={`${provider.regionId}:${provider.sourceId}`} className="region-env__overridden">
                  <s>{origin(provider)}</s>
                  <span>overridden</span>
                </p>
              ))}
            </li>
          ))}
        </ul>
      </section>

      {stale.length > 0 ? (
        <section className="region-env__section" aria-label="Restart to apply" data-testid="region-env-stale">
          <header className="region-env__heading">
            <h3>Restart to apply</h3>
            <p>A running seat keeps the environment it started with. These started before the last change.</p>
          </header>
          <ul className="region-env__stale">
            {stale.map((seat) => (
              <li key={seat.seatId} className="region-env__stale-seat">
                <div className="region-env__source-text">
                  <span className="region-env__source-title">{seat.title}</span>
                  <span className="region-env__source-detail">
                    {seat.changed.length > 0 ? `Changes on restart: ${seat.changed.join(", ")}` : "Its environment changes on restart."}
                  </span>
                </div>
                <Button
                  type="button"
                  size="xs"
                  disabled={restarting !== undefined}
                  onClick={() => void restart(seat)}
                  data-testid="region-env-restart"
                >
                  <RotateCw size={11} aria-hidden />
                  {restarting === seat.seatId ? "restarting" : "restart"}
                </Button>
              </li>
            ))}
          </ul>
          {restartProblem ? (
            <p className="region-env__error" role="alert">
              {restartProblem}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="region-env__section" aria-label="Sealed">
        <label className="region-env__sealed">
          <Switch
            checked={sealed}
            onCheckedChange={(next) => commit({ ...environment, sealed: next })}
            aria-label="Sealed"
            data-testid="region-env-sealed"
          />
          <span>
            <span className="region-env__sealed-title">Sealed</span>
            <span className="region-env__hint">
              {sealed
                ? "Seats in this region get only what is listed here. Nothing comes in from the regions around it."
                : "Seats in this region also get what the regions around it provide."}
            </span>
          </span>
        </label>
      </section>

      <section className="region-env__section" aria-label="Folders">
        <header className="region-env__heading">
          <h3>Folders</h3>
          <p>Extra directories the seats in this region may reach, such as a config folder.</p>
        </header>
        <ul className="region-env__folders">
          {folders.map((folder) => (
            <li key={folder} className="region-env__folder" data-testid="region-env-folder">
              <span className="region-env__folder-path">{folder}</span>
              <IconButton
                size="sm"
                tone="danger"
                aria-label={`Remove ${folder}`}
                title="Remove"
                onClick={() => commit({ ...environment, folders: folders.filter((existing) => existing !== folder) })}
              >
                <Trash2 size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
        <form
          className="region-env__folder-add"
          onSubmit={(event) => {
            event.preventDefault();
            addFolder();
          }}
        >
          <Input
            dense
            value={folderDraft}
            placeholder="~/.config/gcloud"
            spellCheck={false}
            autoComplete="off"
            aria-label="Folder to add"
            aria-invalid={newFolderProblem ? true : undefined}
            data-testid="region-env-folder-input"
            onChange={(event) => setFolderDraft(event.target.value)}
          />
          <Button type="submit" size="sm" variant="chrome" disabled={!folderDraft.trim() || newFolderProblem !== undefined}>
            <Plus size={14} aria-hidden />
            add folder
          </Button>
        </form>
        {newFolderProblem ? (
          <p className="region-env__error" role="alert">
            {newFolderProblem}
          </p>
        ) : null}
      </section>
    </div>
  );
}
