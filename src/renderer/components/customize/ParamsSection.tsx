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
import { resolveManagedLaunch } from "@shared/managed-terminal-launch";
import {
  permissionModeOptions,
  planSeatLaunch,
  seatLaunchParamsChangeError,
  seatLaunchParamsDiffer,
  seatLaunchParamsOf,
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
  readonly hasSession?: boolean;
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
function ParamsForm({ harness, stored, cwd, hasSession, lead, onDraft, footer }: ParamsFormProps) {
  const template = templateFor(harness);
  const spec = template.argvSpec;
  const ampThread = harness === "amp" && hasSession === true;
  const [model, setModel] = useState(stored.model ?? "");
  const [effort, setEffort] = useState(stored.effort ?? "");
  const [mode, setMode] = useState(stored.mode ?? "");
  const [customMode, setCustomMode] = useState(() =>
    harness === "amp" && Boolean(stored.mode) && !(template.modes ?? []).includes(stored.mode ?? ""),
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
    () => ampThread
      ? resolveManagedLaunch(harness, { ...current, cwd, sessionId: "<saved thread>" }, {}).argv ?? []
      : planSeatLaunch({ harness, params: current, base: { cwd } }).launch.argv ?? [],
    [harness, current, cwd, ampThread],
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
  const efforts = template.efforts;
  const modes = discoveredModes ?? template.modes ?? [];
  // Keep the custom-entry option distinct from any discovered or typed key.
  let customModeOption = "__custom_mode__";
  while (modes.includes(customModeOption) || mode === customModeOption) customModeOption += "_";
  const permissionModes = permissionModeOptions(harness, permissionMode);

  return (
    <div className="customize-launch" data-testid="seat-start-params">
      <p className="agent-editor__hint">{lead}</p>

      {spec.modelFlag || spec.modelEnvKey ? (
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
          <span className="agent-editor__field-label">{ampThread ? "creation mode" : "mode"}</span>
          {ampThread ? (
            <Input readOnly value={mode || "Amp default at creation"} aria-label="Creation mode" />
          ) : (
            <>
              <Select
                dense
                value={customMode ? customModeOption : mode}
                aria-label="Mode"
                options={[
                  ...optionsWith(modes, mode),
                  ...(harness === "amp" ? [{ value: customModeOption, label: "other key or label…" }] : []),
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
          {harness === "amp" ? (
            <p className="agent-editor__hint">
              {ampThread
                ? "This records the creation choice, not the live mode. Use Amp's dial before the first message, or re-seat from Launch for a new thread."
                : "Built-in or plugin mode, by key or label. Amp controls the model and effort."}
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
                  ?? (ampThread && [flag.flag, ...flag.aliases].some((name) => name === "--features" || name === "--fast")
                    ? "change this thread's features in Amp"
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
        <span className="agent-editor__field-label">{ampThread ? "resumes as" : "starts as"}</span>
        <code className="customize-params__preview" data-testid="seat-start-params-preview">
          {formatExtraArgs(preview)}
        </code>
        <p className="agent-editor__hint">
          {harness === "amp"
            ? ampThread
              ? "The thread keeps its saved mode and features. Fast and Plaid can be toggled inside Amp."
              : "Junto sets mode and startup features when it creates the private thread."
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
  const [hasSession, setHasSession] = useState(harness === "amp");
  const canvas = use$(() => terminal$.canvasByNodeId[node.id].get() ?? state$.canvasName.get());
  useEffect(() => {
    let current = true;
    if (harness !== "amp") { setHasSession(false); return; }
    const api = getJuntoApi();
    if (!api?.modelSeatLaunchState) return;
    void api.modelSeatLaunchState({ canvas, id: node.id }).then((read) => {
      if (current) setHasSession(read.hasSession);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [canvas, node.id, node.bindingId, harness]);
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
      hasSession={hasSession}
      lead={harness === "amp"
        ? hasSession
          ? "Client options for this Amp seat. Saving restarts its viewer and resumes the same thread."
          : "Choices for this seat's next Amp thread. Mode and startup features are set when the private thread is created."
        : `What ${templateFor(harness).displayName} is started with on this seat. Saving restarts a running agent on the new parameters and resumes the same session.`}
      footer={({ params, changed, settle }) => {
        const changeError = seatLaunchParamsChangeError(node, params, hasSession);
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
