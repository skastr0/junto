import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { SlidersHorizontal } from "lucide-react";
import type { Seat } from "@shared/model";
import {
  formatExtraArgs,
  parseExtraArgsText,
  reservedLaunchFlags,
  sanitizeExtraArgs,
  type HarnessHelpFlag,
} from "@shared/launch-extra-args";
import { isHarnessId, templateFor, type HarnessId } from "@shared/managed-terminal-templates";
import { paramSpec, type HarnessParams } from "@shared/harness-domain";
import { HARNESS_RECORDS } from "@shared/harness-records";
import {
  permissionModeOptions,
  seatLaunchParamsChangeError,
  seatLaunchParamsDiffer,
  seatLaunchParamsOf,
  seatStartPreviewArgv,
  type SeatLaunchParams,
} from "@shared/seat-launch-params";
import { openAgentEditor } from "../../lib/agent-editor-state";
import { useHarnessLaunchOptions } from "../../lib/harness-launch-options";
import { performSeatRelaunch } from "../../lib/seat-relaunch";
import { terminal$ } from "../../lib/terminal-state";
import { state$ } from "../../lib/state";
import { getJuntoApi } from "../../lib/junto-api";
import { Button, IconButton, Input, Select } from "../ui";
import type { AgentEditorDraft, AgentEditorSectionProps } from "../agent-editor/sections";
import "./customize.css";

// Start params: exactly what this seat's harness is started with. The dials
// (model, effort, mode, permission) plus any other argument the harness
// accepts, picked from its own `--help` or typed. Saving restarts a running
// harness on the new parameters and resumes the same session.

/** Section id, for `openAgentEditor(seatId, { section })`. */
export const START_PARAMS_SECTION_ID = "params";

const HARNESS_DEFAULT = { value: "", label: "harness default" } as const;

/** What a seat's params say about its session, read from the harness record. */
const sessionFacts = (params: HarnessParams) => {
  const mode = paramSpec(params, "mode");
  const owned = paramSpec(params, "extraArgs")?.sessionOwnedFlags ?? [];
  return {
    /** The session keeps the mode it was created with. */
    modeFrozen: mode?.resume === "frozenWithSession",
    /** Flags the session owns once it exists. */
    ownedFlags: new Set(owned.map((entry) => entry.flag)),
    /** Whether a seat must know if its session exists before it is edited. */
    matters: mode?.resume === "frozenWithSession" || owned.length > 0,
  };
};

const optionsWith = (values: readonly string[], current: string) => [
  HARNESS_DEFAULT,
  ...[...new Set([...values, ...(current ? [current] : [])])].map((value) => ({
    value,
    label: value,
  })),
];

export function ParamsSection({ seat }: AgentEditorSectionProps) {
  const node = seat.node;
  const view = useMemo(() => (node ? seatLaunchParamsOf(node) : undefined), [node]);
  if (seat.draft) return <DraftParams draft={seat.draft} />;
  if (!view || !node) {
    return <p className="agent-editor__hint">This seat has no harness to start.</p>;
  }
  return <SeatParams node={node} harness={view.harness} stored={view.params} />;
}

type ParamsFormProps = {
  readonly harness: HarnessId;
  readonly stored: SeatLaunchParams;
  /** Working folder shown in nothing, but part of the resolved launch. */
  readonly cwd?: string;
  readonly settingsFixed?: boolean;
  readonly lead: string;
  /** Called with every edit, already sanitized. */
  readonly onDraft?: (params: SeatLaunchParams) => void;
  /** Rendered under the form with the current sanitized parameters. */
  readonly footer?: (current: {
    readonly params: SeatLaunchParams;
    readonly changed: boolean;
    readonly settle: () => void;
  }) => ReactNode;
};

/** The fields, the harness's own options, and the resolved command. */
function ParamsForm({ harness, stored, cwd, settingsFixed, lead, onDraft, footer }: ParamsFormProps) {
  const template = templateFor(harness);
  const params = HARNESS_RECORDS[harness].params;
  const modeSpec = paramSpec(params, "mode");
  const effortSpec = paramSpec(params, "effort");
  const facts = sessionFacts(params);
  // A seat that picks up where it was keeps the mode and startup flags it
  // started with: the form records the creation choice and previews the pick-up.
  const fixedSettings = facts.matters && settingsFixed === true;
  const [model, setModel] = useState(stored.model ?? "");
  const [effort, setEffort] = useState(stored.effort ?? "");
  const [mode, setMode] = useState(stored.mode ?? "");
  const [customMode, setCustomMode] = useState(() =>
    modeSpec?.custom === true && Boolean(stored.mode) && !(template.modes ?? []).includes(stored.mode ?? ""),
  );
  const [permissionMode, setPermissionMode] = useState(stored.permissionMode ?? "");
  const [extraText, setExtraText] = useState(formatExtraArgs(stored.extraArgs));
  const [filter, setFilter] = useState("");

  const { flags, modes: discoveredModes, loading } = useHarnessLaunchOptions(harness, cwd);
  const reserved = useMemo(() => reservedLaunchFlags(harness), [harness]);

  const extra = useMemo(
    () => sanitizeExtraArgs(harness, parseExtraArgsText(extraText)),
    [harness, extraText],
  );
  const current: SeatLaunchParams = useMemo(
    () => ({
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? { mode } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      extraArgs: extra.args,
    }),
    [model, effort, mode, permissionMode, extra.args],
  );
  const preview = useMemo(
    () => seatStartPreviewArgv({ harness, params: current, cwd, resumesSession: fixedSettings }),
    [harness, current, cwd, fixedSettings],
  );
  const changed = seatLaunchParamsDiffer({ ...stored, extraArgs: stored.extraArgs ?? [] }, current);

  const edited = useRef(false);
  const touch = <T,>(set: (value: T) => void) => (value: T): void => {
    edited.current = true;
    set(value);
  };
  useEffect(() => {
    if (edited.current) onDraft?.(current);
    // Only an operator edit is a draft change; `current` is the edit's result,
    // and `onDraft` is a fresh closure on every render.
  }, [current]);

  const addFlag = useCallback((flag: HarnessHelpFlag) => {
    edited.current = true;
    setExtraText((text) => {
      const present = parseExtraArgsText(text).some(
        (token) => token === flag.flag || token.startsWith(`${flag.flag}=`),
      );
      if (present) return text;
      const addition = flag.value ? `${flag.flag} ` : flag.flag;
      const base = text.trim();
      return base.length > 0 ? `${base} ${addition}` : addition;
    });
  }, []);

  const needle = filter.trim().toLowerCase();
  const shown = flags.filter(
    (flag) =>
      needle.length === 0 ||
      flag.flag.toLowerCase().includes(needle) ||
      flag.aliases.some((alias) => alias.toLowerCase().includes(needle)) ||
      flag.description.toLowerCase().includes(needle),
  );
  const efforts = effortSpec?.options.source === "fixed" ? effortSpec.options.values : [];
  const modes = modeSpec ? discoveredModes ?? (modeSpec.options.source === "fixed" ? modeSpec.options.values : []) : [];
  // Keep the custom-entry option distinct from any discovered or typed key.
  let customModeOption = "__custom_mode__";
  while (modes.includes(customModeOption) || mode === customModeOption) customModeOption += "_";
  const permissionModes = permissionModeOptions(harness, permissionMode);

  return (
    <div className="customize-launch" data-testid="seat-start-params">
      <p className="agent-editor__hint">{lead}</p>

      {paramSpec(params, "model") ? (
        <label className="agent-editor__field">
          <span className="agent-editor__field-label">model</span>
          <Input
            value={model}
            placeholder="harness default"
            aria-label="Model"
            spellCheck={false}
            onChange={(event) => touch(setModel)(event.target.value)}
          />
        </label>
      ) : null}

      {efforts.length > 0 ? (
        <label className="agent-editor__field">
          <span className="agent-editor__field-label">effort</span>
          <Select dense value={effort} aria-label="Effort" options={optionsWith(efforts, effort)} onChange={touch(setEffort)} />
        </label>
      ) : null}

      {modes.length > 0 ? (
        <div className="agent-editor__field">
          <span className="agent-editor__field-label">{fixedSettings && facts.modeFrozen ? "creation mode" : "mode"}</span>
          {fixedSettings && facts.modeFrozen ? (
            <Input readOnly value={mode || `${template.displayName} default at creation`} aria-label="Creation mode" />
          ) : (
            <>
              <Select
                dense
                value={customMode ? customModeOption : mode}
                aria-label="Mode"
                options={[
                  ...optionsWith(modes, mode),
                  ...(modeSpec?.custom ? [{ value: customModeOption, label: "other key or label…" }] : []),
                ]}
                onChange={(value) => {
                  setCustomMode(value === customModeOption);
                  if (value !== customModeOption) touch(setMode)(value);
                }}
              />
              {customMode ? (
                <Input
                  value={mode}
                  aria-label="Mode key or label"
                  placeholder="plugin mode key or label"
                  spellCheck={false}
                  onChange={(event) => touch(setMode)(event.target.value)}
                />
              ) : null}
            </>
          )}
          {fixedSettings && facts.modeFrozen ? (
            <p className="agent-editor__hint">
              This records the creation choice, not the live mode. Change it in {template.displayName} before the first
              message, or re-seat from Launch for a new session.
            </p>
          ) : modeSpec?.custom && !paramSpec(params, "model") ? (
            <p className="agent-editor__hint">
              Built-in or plugin mode, by key or label. {template.displayName} chooses the model and effort from it.
            </p>
          ) : null}
        </div>
      ) : null}

      {permissionModes.length > 0 ? (
        <label className="agent-editor__field">
          <span className="agent-editor__field-label">permission mode</span>
          <Select
            dense
            value={permissionMode}
            aria-label="Permission mode"
            options={optionsWith(permissionModes, permissionMode)}
            onChange={touch(setPermissionMode)}
          />
        </label>
      ) : null}

      <label className="agent-editor__field">
        <span className="agent-editor__field-label">extra arguments</span>
        <Input
          value={extraText}
          placeholder="--flag value --other-flag"
          aria-label="Extra arguments"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => touch(setExtraText)(event.target.value)}
        />
      </label>
      {extra.rejected.length > 0 ? (
        <ul className="customize-params__rejected" role="alert">
          {extra.rejected.map((item, index) => (
            <li key={`${item.token}-${index}`}>
              <code>{item.token}</code> is left out: {item.reason}.
            </li>
          ))}
        </ul>
      ) : null}

      <div className="agent-editor__field">
        <span className="agent-editor__field-label">options {template.displayName} accepts</span>
        {loading ? (
          <p className="agent-editor__hint" role="status">Reading the installed harness…</p>
        ) : flags.length === 0 ? (
          <p className="agent-editor__hint">
            The installed harness listed no options. Type any argument above.
          </p>
        ) : (
          <>
            <Input
              value={filter}
              placeholder="filter options"
              aria-label="Filter options"
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
            />
            <ul className="customize-params__flags" aria-label="Harness options">
              {shown.map((flag) => {
                const why = reserved.get(flag.flag) ?? flag.aliases.map((alias) => reserved.get(alias)).find(Boolean)
                  ?? (fixedSettings && [flag.flag, ...flag.aliases].some((name) => facts.ownedFlags.has(name))
                    ? `the session owns this; change it in ${template.displayName}`
                    : undefined);
                return (
                  <li key={flag.flag} className="customize-params__flag" data-reserved={why ? "true" : undefined}>
                    <button
                      type="button"
                      className="customize-params__flag-add"
                      disabled={Boolean(why)}
                      title={why ?? `Add ${flag.flag}`}
                      onClick={() => addFlag(flag)}
                    >
                      <code>
                        {[flag.flag, ...flag.aliases].join(", ")}
                        {flag.value ? ` ${flag.value}` : ""}
                      </code>
                      <span>{why ? why : flag.description}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <div className="agent-editor__field">
        <span className="agent-editor__field-label">{fixedSettings ? "resumes as" : "starts as"}</span>
        <code className="customize-params__preview" data-testid="seat-start-params-preview">
          {formatExtraArgs(preview)}
        </code>
        <p className="agent-editor__hint">
          {facts.matters
            ? fixedSettings
              ? `The session keeps its saved mode and startup flags; ${template.displayName} can change them inside it.`
              : "Junto sets the mode and startup flags when it creates the session."
            : "Junto adds the seat's session and instructions when it starts the harness."}
        </p>
      </div>

      {footer?.({
        params: current,
        changed,
        settle: () => setExtraText(formatExtraArgs(extra.args)),
      })}
    </div>
  );
}

function SeatParams({
  node,
  harness,
  stored,
}: {
  readonly node: Seat;
  readonly harness: HarnessId;
  readonly stored: SeatLaunchParams;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sessionMatters = sessionFacts(HARNESS_RECORDS[harness].params).matters;
  const [settingsFixed, setSettingsFixed] = useState(sessionMatters);
  const canvas = use$(() => terminal$.canvasByNodeId[node.id].get() ?? state$.canvasName.get());
  useEffect(() => {
    let current = true;
    if (!sessionMatters) { setSettingsFixed(false); return; }
    const api = getJuntoApi();
    if (!api?.modelSeatLaunchState) return;
    void api.modelSeatLaunchState({ canvas, id: node.id }).then((read) => {
      if (current) setSettingsFixed(read.settingsFixed);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [canvas, node.id, node.bindingId, sessionMatters]);
  const bindingId: string = node.bindingId;
  const running = use$(() => {
    const status = bindingId ? terminal$.sessionByBindingId[bindingId].get()?.status : undefined;
    return status === "running" || status === "starting";
  });

  const save = async (params: SeatLaunchParams, settle: () => void): Promise<void> => {
    setBusy(true);
    setError("");
    setNotice("");
    const result = await performSeatRelaunch(node, params);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    settle();
    setNotice(
      result.restarted
        ? "Restarted on the new parameters. The session continues."
        : "Saved. The next start uses these parameters.",
    );
  };

  return (
    <ParamsForm
      harness={harness}
      stored={stored}
      cwd={node.launch?.cwd}
      settingsFixed={settingsFixed}
      lead={sessionMatters
        ? settingsFixed
          ? `Client options for this ${templateFor(harness).displayName} seat. Saving restarts its viewer and resumes the same session.`
          : `Choices for this seat's next ${templateFor(harness).displayName} session. Mode and startup flags are set when it is created.`
        : `What ${templateFor(harness).displayName} is started with on this seat. Saving restarts a running agent on the new parameters and resumes the same session.`}
      footer={({ params, changed, settle }) => {
        const changeError = seatLaunchParamsChangeError(node, params, settingsFixed);
        return (
          <>
            <div className="customize-params__actions">
              <Button size="sm" variant="primary" disabled={busy || !changed || Boolean(changeError)} onClick={() => void save(params, settle)}>
                {running ? "Save and restart" : "Save"}
              </Button>
              {busy ? <span className="agent-editor__hint" role="status">{running ? "Restarting…" : "Saving…"}</span> : null}
              {notice ? <span className="agent-editor__hint" role="status">{notice}</span> : null}
            </div>
            {changeError || error ? <p className="customize-guidance__error" role="alert">{changeError || error}</p> : null}
          </>
        );
      }}
    />
  );
}

/** A profile being created: every edit lands on the draft at once. */
function DraftParams({ draft }: { readonly draft: AgentEditorDraft }) {
  const { harness, profile, ...launch } = draft.launch;
  return (
    <ParamsForm
      key={harness}
      harness={harness}
      stored={launch}
      lead={`What ${templateFor(harness).displayName} is started with on every seat made from this profile.`}
      onDraft={(params) =>
        draft.configure({
          harness,
          ...(profile ? { profile } : {}),
          ...params,
          extraArgs: params.extraArgs ?? [],
        })
      }
    />
  );
}

/** The seat toolbar's entry: open this seat's start parameters. */
export function StartParamsToolbarAction({ seatId }: { readonly seatId: string }) {
  return (
    <IconButton
      className="nodrag nopan"
      aria-label="Start parameters"
      title="Start parameters (model, permissions, harness arguments)"
      data-testid="toolbar-start-params"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openAgentEditor(seatId, { section: START_PARAMS_SECTION_ID });
      }}
    >
      <SlidersHorizontal size={14} />
    </IconButton>
  );
}

/** True when the node is a managed seat whose harness is a known template. */
export const hasStartParams = (harness: string | undefined): boolean =>
  harness !== undefined && isHarnessId(harness);
