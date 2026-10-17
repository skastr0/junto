/**
 * Harness params: the dials an operator sets on a harness launch, declared per
 * harness as data. Settings (harness defaults), the seat's Params section and
 * the launch picker all render and validate from these declarations; none of
 * them branches on a harness id.
 *
 * A param says:
 * - which values it takes (a fixed list, this machine's inventory, or free
 *   text) and whether a value off the list is allowed;
 * - how it reaches the harness (a flag, a config key, an env var, a slug on
 *   the model, or a flag set per value);
 * - what a resume does with it (re-passed every launch, or frozen once the
 *   session exists);
 * - which layers may set it, and what it travels with.
 *
 * Layers resolve in one order: launch choice over seat over the machine's
 * override over the app-wide harness default. A param nobody set resolves to
 * nothing, and nothing is emitted: the harness's own config decides.
 * An explicit non-empty value wins; an explicit extra-args list wins whole,
 * including an empty one.
 */
import { Result, Schema } from "effect";
import type { HarnessId, ManagedTerminalTemplate } from "../managed-terminal-templates";

export const HARNESS_PARAM_KEYS = [
  "model",
  "provider",
  "effort",
  "mode",
  "permissionMode",
  "profile",
  "extraArgs",
] as const;
export const HarnessParamKey = Schema.Literals(HARNESS_PARAM_KEYS);
export type HarnessParamKey = typeof HarnessParamKey.Type;

/** Least specific first: the app-wide default, its per-machine override, the seat, one launch. */
export const PARAM_LAYERS = ["harnessDefault", "machineDefault", "seat", "launch"] as const;
export const ParamLayer = Schema.Literals(PARAM_LAYERS);
export type ParamLayer = typeof ParamLayer.Type;

export const ParamOptions = Schema.Union([
  /** The harness accepts exactly these (efforts, modes, permission modes it declares). */
  Schema.Struct({ source: Schema.Literal("fixed"), values: Schema.Array(Schema.String) }),
  /** Enumerated on the seat's machine; `list` names which inventory list (models by default). */
  Schema.Struct({ source: Schema.Literal("inventory"), list: Schema.optionalKey(Schema.Literals(["models", "profiles"])) }),
  /** Any value; `suggestions` are known-good ones, not a closed set. */
  Schema.Struct({ source: Schema.Literal("free"), suggestions: Schema.Array(Schema.String) }),
]);
export type ParamOptions = typeof ParamOptions.Type;

export const ParamEmission = Schema.Union([
  Schema.Struct({ via: Schema.Literal("flag"), flag: Schema.String }),
  /** A bare flag the harness takes for one value (`--yolo` for yolo); other values emit nothing. */
  Schema.Struct({ via: Schema.Literal("switch"), flag: Schema.String, value: Schema.String }),
  /** Codex `-c model_reasoning_effort="high"`. */
  Schema.Struct({ via: Schema.Literal("configKey"), key: Schema.String }),
  /** fx `FX_MODEL`: read from the environment, rebuilt every launch. */
  Schema.Struct({ via: Schema.Literal("env"), key: Schema.String }),
  /** Cursor: the effort rides inside the model id. */
  Schema.Struct({ via: Schema.Literal("modelSlug") }),
  /** Cursor permission modes: each value emits its own flag set. */
  Schema.Struct({
    via: Schema.Literal("perValue"),
    argv: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
  /** Operator-authored tokens appended after every template-owned flag. */
  Schema.Struct({ via: Schema.Literal("args") }),
]);
export type ParamEmission = typeof ParamEmission.Type;

/**
 * - repass: emitted on every launch, resume included (resumes do not inherit
 *   dials on codex and hermes).
 * - frozenWithSession: the session owns it once it exists (Amp's thread keeps
 *   its mode); changing it means a new session.
 */
export const ParamResume = Schema.Literals(["repass", "frozenWithSession"]);
export type ParamResume = typeof ParamResume.Type;

export const HarnessParamSpec = Schema.Struct({
  key: HarnessParamKey,
  label: Schema.String,
  options: ParamOptions,
  /** A value off the option list is accepted (custom model ids, Amp mode keys). */
  custom: Schema.Boolean,
  emit: ParamEmission,
  resume: ParamResume,
  layers: Schema.Array(ParamLayer),
  /** Another param that must come from the same layer (Hermes provider with model). */
  travelsWith: Schema.optionalKey(HarnessParamKey),
  /** Argv tokens a value brings onto the same launch (Devin `autonomous` needs `--sandbox`). */
  companions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** Values the harness accepts that no picker offers (they need a dial Junto does not show). */
  unoffered: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Other spellings of a flag param: recovery reads them, extra args may not repeat them (Amp mode `-m`, `--mode`). */
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The value names the seat's agent (agent key `host:<value>`); a launch with
   * no stored value recovers it from the key (Hermes profile).
   */
  inAgentKey: Schema.optionalKey(Schema.Literal(true)),
  /** On the extra-args param: flags the operator may not pass, with the reason shown. */
  refusedFlags: Schema.optionalKey(
    Schema.Array(Schema.Struct({ flags: Schema.Array(Schema.String), why: Schema.String })),
  ),
  /**
   * On the extra-args param: tokens the session owns once it exists, dropped
   * on resume (Amp `--features <value>`, `--fast`).
   */
  sessionOwnedFlags: Schema.optionalKey(
    Schema.Array(Schema.Struct({ flag: Schema.String, takesValue: Schema.Boolean })),
  ),
  /** The harness's own default, shown as "Harness default". Never emitted. */
  defaultValue: Schema.optionalKey(Schema.String),
});
export type HarnessParamSpec = typeof HarnessParamSpec.Type;

export type HarnessParams = {
  readonly harness: HarnessId;
  /** In display order. A key the harness has no dial for is absent. */
  readonly params: readonly HarnessParamSpec[];
};

export const paramSpec = (
  params: HarnessParams,
  key: HarnessParamKey,
): HarnessParamSpec | undefined => params.params.find((spec) => spec.key === key);

// ── Values and layers ─────────────────────────────────────────────────────

export type ParamValues = {
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly permissionMode?: string;
  readonly profile?: string;
  readonly extraArgs?: readonly string[];
};

export type ParamLayers = Partial<Readonly<Record<ParamLayer, ParamValues>>>;

export type ResolvedParams = {
  readonly values: ParamValues;
  /** Which layer each resolved value came from. */
  readonly from: Partial<Readonly<Record<HarnessParamKey, ParamLayer>>>;
};

const MOST_SPECIFIC_FIRST: readonly ParamLayer[] = ["launch", "seat", "machineDefault", "harnessDefault"];

const present = (key: HarnessParamKey, values: ParamValues | undefined): boolean => {
  if (!values) return false;
  if (key === "extraArgs") return values.extraArgs !== undefined;
  const value = values[key];
  return value !== undefined && value.trim().length > 0;
};

/**
 * Resolve every declared param across layers. A layer may only set a param
 * that declares it; a `travelsWith` pair resolves from the layer that set its
 * anchor, so a model and its provider never come from different layers.
 */
export const resolveParams = (params: HarnessParams, layers: ParamLayers): ResolvedParams => {
  const values: Record<string, string | readonly string[]> = {};
  const from: Partial<Record<HarnessParamKey, ParamLayer>> = {};
  const pick = (spec: HarnessParamSpec, layer: ParamLayer): void => {
    const value = layers[layer]?.[spec.key];
    if (value === undefined) return;
    values[spec.key] = typeof value === "string" ? value.trim() : value;
    from[spec.key] = layer;
  };
  const anchors = new Map<HarnessParamKey, HarnessParamKey>();
  for (const spec of params.params) {
    if (spec.travelsWith) anchors.set(spec.key, spec.travelsWith);
  }
  for (const spec of params.params) {
    const anchor = anchors.get(spec.key);
    if (anchor !== undefined) continue;
    const layer = MOST_SPECIFIC_FIRST.find(
      (candidate) => spec.layers.includes(candidate) && present(spec.key, layers[candidate]),
    );
    if (layer) pick(spec, layer);
  }
  for (const spec of params.params) {
    const anchor = anchors.get(spec.key);
    if (anchor === undefined) continue;
    const layer = from[anchor];
    if (layer && spec.layers.includes(layer) && present(spec.key, layers[layer])) pick(spec, layer);
  }
  return { values: values as ParamValues, from };
};

// ── Validation ────────────────────────────────────────────────────────────

export class ParamRefusedError extends Schema.TaggedError<ParamRefusedError>()(
  "ParamRefusedError",
  {
    key: Schema.String,
    value: Schema.String,
    reason: Schema.Literals(["unknown", "offList", "frozen", "layer"]),
    message: Schema.String,
  },
) {}

/**
 * Check one value against its declaration. `hasSession` is whether the seat
 * already holds a session; `current` is the value that session started with.
 */
export const checkParam = (
  params: HarnessParams,
  input: {
    readonly key: HarnessParamKey;
    readonly value: string;
    readonly layer: ParamLayer;
    readonly hasSession?: boolean;
    readonly current?: string;
  },
): Result.Result<string, ParamRefusedError> => {
  const value = input.value.trim();
  const refuse = (reason: ParamRefusedError["reason"], message: string) =>
    Result.fail(new ParamRefusedError({ key: input.key, value, reason, message }));
  const spec = paramSpec(params, input.key);
  if (!spec) return refuse("unknown", `${params.harness} has no ${input.key} setting`);
  if (!spec.layers.includes(input.layer)) {
    return refuse("layer", `${input.key} cannot be set as a ${input.layer}`);
  }
  if (spec.options.source === "fixed" && !spec.custom && value !== "" && !spec.options.values.includes(value)) {
    return refuse("offList", `${value} is not one of ${spec.options.values.join(", ")}`);
  }
  if (
    spec.resume === "frozenWithSession" &&
    input.hasSession === true &&
    (input.current ?? "").trim().toLowerCase() !== value.toLowerCase()
  ) {
    return refuse("frozen", `the session keeps its ${spec.label.toLowerCase()}; a change needs a new session`);
  }
  return Result.succeed(value);
};

// ── Declarations from today's templates ───────────────────────────────────

/** Bare permission flags `resolveManagedLaunch` emits for `yolo` and nothing else. */
const SWITCH_PERMISSION_FLAGS: readonly string[] = ["--yolo", "--dangerously-skip-permissions"];

/** Layers Settings, the seat and the picker can each set today. */
const ALL_LAYERS: readonly ParamLayer[] = ["harnessDefault", "machineDefault", "seat", "launch"];
const SEAT_AND_LAUNCH: readonly ParamLayer[] = ["seat", "launch"];
const LAUNCH_ONLY: readonly ParamLayer[] = ["launch"];

/**
 * The params a template's argv spec already encodes. Behaviour-preserving: it
 * reads the same slots `resolveManagedLaunch` emits from. Permission modes
 * are a closed list only where the template names them (`permissionArgv`,
 * `permissionModes`); elsewhere they stay free text with the template default
 * as the one suggestion.
 */
export const paramsOfTemplate = (template: ManagedTerminalTemplate): HarnessParams => {
  const spec = template.argvSpec;
  const params: HarnessParamSpec[] = [];
  const modelEmit: ParamEmission | undefined = spec.modelFlag
    ? { via: "flag", flag: spec.modelFlag }
    : spec.modelEnvKey
      ? { via: "env", key: spec.modelEnvKey }
      : undefined;
  if (modelEmit) {
    params.push({
      key: "model",
      label: "Model",
      options: { source: "inventory" },
      custom: true,
      emit: modelEmit,
      resume: "repass",
      layers: ALL_LAYERS,
    });
  }
  if (spec.providerFlag) {
    params.push({
      key: "provider",
      label: "Provider",
      options: { source: "free", suggestions: [] },
      custom: true,
      emit: { via: "flag", flag: spec.providerFlag },
      resume: "repass",
      layers: LAUNCH_ONLY,
      travelsWith: "model",
    });
  }
  const effortEmit: ParamEmission | undefined = spec.effortFlag
    ? { via: "flag", flag: spec.effortFlag }
    : spec.effortConfigKey
      ? { via: "configKey", key: spec.effortConfigKey }
      : spec.effortModelBracketKey
        ? { via: "modelSlug" }
        : undefined;
  if (effortEmit && template.efforts.length > 0) {
    params.push({
      key: "effort",
      label: "Effort",
      options: { source: "fixed", values: template.efforts },
      custom: false,
      emit: effortEmit,
      resume: "repass",
      layers: ALL_LAYERS,
    });
  }
  if (spec.modeFlag) {
    params.push({
      key: "mode",
      label: "Mode",
      options: { source: "fixed", values: template.modes ?? [] },
      // Closed unless the harness record says otherwise (Amp takes plugin mode keys).
      custom: false,
      emit: { via: "flag", flag: spec.modeFlag },
      resume: spec.resumeMode === "subcommand" && spec.resumeSubcommand ? "frozenWithSession" : "repass",
      layers: SEAT_AND_LAUNCH,
    });
  }
  const permissionEmit: ParamEmission | undefined = spec.permissionArgv
    ? { via: "perValue", argv: spec.permissionArgv }
    : spec.permissionModeFlag && SWITCH_PERMISSION_FLAGS.includes(spec.permissionModeFlag)
      ? { via: "switch", flag: spec.permissionModeFlag, value: "yolo" }
      : spec.permissionModeFlag
      ? { via: "flag", flag: spec.permissionModeFlag }
      : spec.permissionModeEnvKey
        ? { via: "env", key: spec.permissionModeEnvKey }
        : undefined;
  if (permissionEmit) {
    const listed = spec.permissionArgv ? Object.keys(spec.permissionArgv) : template.permissionModes;
    const companions = spec.permissionCompanions;
    const suggestions = template.defaultPermissionMode ? [template.defaultPermissionMode] : [];
    params.push({
      key: "permissionMode",
      label: "Permission mode",
      options: listed ? { source: "fixed", values: listed } : { source: "free", suggestions },
      custom: listed === undefined,
      emit: permissionEmit,
      resume: "repass",
      layers: ALL_LAYERS,
      ...(companions ? { companions, unoffered: Object.keys(companions) } : {}),
      ...(template.defaultPermissionMode ? { defaultValue: template.defaultPermissionMode } : {}),
    });
  }
  if (spec.profileFlag) {
    params.push({
      key: "profile",
      label: "Profile",
      options: { source: "inventory", list: "profiles" },
      custom: true,
      emit: { via: "flag", flag: spec.profileFlag },
      resume: "repass",
      layers: LAUNCH_ONLY,
    });
  }
  params.push({
    key: "extraArgs",
    label: "Extra arguments",
    options: { source: "free", suggestions: [] },
    custom: true,
    emit: { via: "args" },
    resume: "repass",
    layers: ALL_LAYERS,
  });
  return { harness: template.harness, params };
};
