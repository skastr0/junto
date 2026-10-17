/**
 * Settings → Agents for one named machine. Every row renders and validates
 * from the harness record's params (`resolveParams`, `checkParam`);
 * nothing here branches on a harness id. Two Settings layers per param: the
 * app-wide default and this machine's override. A key set in neither shows
 * "Harness default" and is never passed to the harness.
 *
 * The machine is the one the page head's dropdown chose (lib/settings-machine.ts).
 * Its harnesses come from its inventory, asked the same way for
 * every machine (lib/harness-machine-source.ts). Until an answer exists the
 * page says so beside each harness and stays usable; no loader stands in.
 *
 * Gated by HARNESS_SETTINGS_ENABLED (ship/prod off).
 */
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import { useEffect, useId, useMemo, useState } from "react";
import {
  checkParam,
  inventoryOptions,
  isInventoryStale,
  resolveParams,
  type HarnessInventory,
  type HarnessParamKey,
  type HarnessParamSpec,
  type HarnessParams,
  type MachineInventory,
  checkNativeSetting,
  type NativeSettingSpec,
  type NativeSettingWrite,
  type ParamLayer,
} from "@shared/harness-domain";
import { NATIVE_SETTINGS, nativeSettingsFor } from "@shared/harness-domain/native-catalogue";
import { harnessSettingLayers } from "@shared/harness-settings";
import { HARNESS_RECORDS } from "@shared/harness-records";
import { allTemplates, type HarnessId } from "@shared/managed-terminal-templates";
import { formatExtraArgs, parseExtraArgsText, sanitizeExtraArgs } from "@shared/launch-extra-args";
import {
  harnessPrefsFor,
  type HarnessInstancePrefsPatch,
  type MachineHarnessPrefsPatch,
  type Settings,
} from "@shared/settings";
import { HUE_TEXT, INK } from "../../lib/theme";
import { state$ } from "../../lib/state";
import { patchSettings } from "../../lib/settings-state";
import { machineLabel } from "../../lib/machines";
import { harnessMachineSource, type InventoryRefusal } from "../../lib/harness-machine-source";
import { formatSeatAwarenessAge } from "../../lib/seat-awareness";
import { useSettingsMachine } from "../../lib/settings-machine";
import { Input, Select, Switch } from "../ui";
import { FieldRow } from "./FieldRow";
import "./harness-settings.css";

/** The layers this page writes, least specific first. */
const SETTINGS_LAYERS = ["harnessDefault", "machineDefault"] as const satisfies readonly ParamLayer[];
type SettingsLayer = (typeof SETTINGS_LAYERS)[number];

/** Params Settings keeps; a declared param outside this set is set from the seat or the launch. */
const STORED_KEYS = ["model", "effort", "permissionMode", "extraArgs"] as const satisfies readonly HarnessParamKey[];
type StoredKey = (typeof STORED_KEYS)[number];
const isStoredKey = (key: HarnessParamKey): key is StoredKey => (STORED_KEYS as readonly string[]).includes(key);

const HARNESS_DEFAULT = "Harness default";

/** How soon the page asks the machine's cache again while a scan runs behind it. */
const INVENTORY_REREAD_MS = 2_000;

type InventoryRead =
  | { readonly state: "unread" }
  | { readonly state: "answered"; readonly inventory: MachineInventory }
  | { readonly state: "refused"; readonly refusal: InventoryRefusal };

export function HarnessesSettingsSection({ machine: chosen }: { readonly machine?: string }) {
  const settings = use$(state$.settings);
  const shown = useSettingsMachine();
  const machine = chosen && chosen.length > 0 ? chosen : shown.name;
  const [read, setRead] = useState<InventoryRead>({ state: "unread" });

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRead({ state: "unread" });
    // The cache answers at once; while a scan runs behind it, ask the cache
    // again until the scan has landed. Nothing waits on the scan itself.
    const ask = (): void => {
      void harnessMachineSource()
        .inventory(machine)
        .then((answer) => {
          if (!current) return;
          setRead(
            Result.isSuccess(answer)
              ? { state: "answered", inventory: answer.success }
              : { state: "refused", refusal: answer.failure },
          );
          if (Result.isSuccess(answer) && answer.success.harnesses.some((row) => row.refreshing)) {
            timer = setTimeout(ask, INVENTORY_REREAD_MS);
          }
        });
    };
    ask();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [machine]);

  const named = machine === shown.name ? shown.label : machineLabel(machine);
  const label = machine === shown.name && shown.isThisMachine ? `${named} (this machine)` : named;

  return (
    <div className="settings-section" aria-label={`Agent harness settings for ${machineLabel(machine)}`} data-machine={machine}>
      <p className="settings-note" data-testid="harness-settings-machine">
        Settings for seats on <strong style={{ color: INK }}>{label}</strong>. A value under All machines applies
        everywhere; a value for this machine wins on it. Anything left as {HARNESS_DEFAULT} is not passed, so the
        harness&apos;s own config decides.
      </p>
      {read.state === "refused" ? <RefusedInventory machineName={named} refusal={read.refusal} /> : null}
      <ul className="settings-harness-list" role="list">
        {allTemplates().map((template) => {
          const params = HARNESS_RECORDS[template.harness].params;
          const shownInventory =
            read.state === "answered"
              ? read.inventory
              : read.state === "refused"
                ? read.refusal.last?.inventory
                : undefined;
          const inventory = shownInventory?.harnesses.find((row) => row.harness === template.harness);
          return (
            <HarnessCard
              key={template.harness}
              harness={template.harness}
              displayName={template.displayName}
              params={params}
              machine={machine}
              machineName={machineLabel(machine)}
              settings={settings}
              read={read}
              inventory={inventory}
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A machine that did not answer: why, in its typed words, and what it last
 * sent with its age. The cards below show that last snapshot.
 */
function RefusedInventory({ machineName, refusal }: { readonly machineName: string; readonly refusal: InventoryRefusal }) {
  const why = refusal.failure ?? refusal.error.reason;
  return (
    <p className="settings-note" role="status" data-testid="harness-inventory-refused" data-failure={why}>
      <span style={{ color: HUE_TEXT.crimson }}>
        {machineName} did not answer ({why}): {refusal.error.message}.
      </span>{" "}
      {refusal.last
        ? `Showing what it sent ${formatSeatAwarenessAge(Date.now() - refusal.last.receivedAt)}.`
        : "It has not sent an inventory yet."}
    </p>
  );
}

const inventoryLine = (read: InventoryRead, inventory: HarnessInventory | undefined, now: number): string => {
  if (read.state === "unread") return "inventory not read yet";
  if (read.state === "refused" && inventory === undefined) return "inventory unavailable";
  if (!inventory) return "not reported by this machine";
  if (!inventory.installed) return "not installed";
  const version = inventory.version ? `version ${inventory.version}` : "installed";
  if (inventory.lastFailure) {
    // A remote machine sends the reason without its command output.
    const { reason, message } = inventory.lastFailure;
    return message ? `${version}, last scan ${reason}: ${message}` : `${version}, last scan ${reason}`;
  }
  if (inventory.refreshing) return `${version}, rescanning`;
  return isInventoryStale(inventory, now) ? `${version}, model list out of date` : version;
};

/**
 * What was tested against the installed version. An unverified harness still
 * launches: the line says what was tested, never that it is broken.
 */
const verificationLine = (inventory: HarnessInventory | undefined): string | undefined => {
  const verification = inventory?.installed ? inventory.verification : undefined;
  if (verification === undefined) return undefined;
  switch (verification.verdict) {
    case "verified":
      return `Tested on this version (verified ${verification.from} through ${verification.through})`;
    case "older":
      return `Older than tested (verified from ${verification.from})`;
    case "newer":
      return `Newer than tested (verified through ${verification.through})`;
    case "unknown":
      return `Not compared with the tested versions (${verification.from} through ${verification.through})`;
  }
};

function HarnessCard({
  harness,
  displayName,
  params,
  machine,
  machineName,
  settings,
  read,
  inventory,
}: {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly params: HarnessParams;
  readonly machine: string;
  readonly machineName: string;
  readonly settings: Settings;
  readonly read: InventoryRead;
  readonly inventory: HarnessInventory | undefined;
}) {
  const layers = harnessSettingLayers(settings, machine, harness);
  const resolved = resolveParams(params, layers);
  const specs = params.params.filter(
    (spec) => isStoredKey(spec.key) && SETTINGS_LAYERS.some((layer) => spec.layers.includes(layer)),
  );
  const notInstalled = inventory !== undefined && !inventory.installed;

  const patchAll = (prefs: HarnessInstancePrefsPatch): void => {
    void patchSettings({ harnesses: { byHarness: { [harness]: prefs } } });
  };
  const patchMachine = (prefs: MachineHarnessPrefsPatch): void => {
    void patchSettings({ harnesses: { byMachine: { [machine]: { byHarness: { [harness]: prefs } } } } });
  };

  return (
    <li className="settings-harness-card" data-harness={harness} data-installed={notInstalled ? "false" : "true"}>
      <div className="settings-harness-card__head">
        <strong style={{ color: INK }}>{displayName}</strong>
        <span className="settings-field__hint">{inventoryLine(read, inventory, Date.now())}</span>
        {verificationLine(inventory) ? (
          <span className="settings-field__hint" data-verdict={inventory?.verification?.verdict}>
            {verificationLine(inventory)}
          </span>
        ) : null}
      </div>

      <FieldRow label="Offer in palette">
        <Switch
          checked={harnessPrefsFor(settings, harness).enabled !== false}
          aria-label={`Offer ${displayName} in palette`}
          onCheckedChange={(enabled) => patchAll({ enabled })}
        />
      </FieldRow>

      {specs.map((spec) => (
        <ParamRow
          key={spec.key}
          spec={spec}
          params={params}
          displayName={displayName}
          machineName={machineName}
          inventory={inventory}
          stored={{
            harnessDefault: layers.harnessDefault?.[spec.key],
            machineDefault: layers.machineDefault?.[spec.key],
          }}
          resolvedFrom={resolved.from[spec.key]}
          resolvedValue={resolved.values[spec.key]}
          onCommit={(layer, value) =>
            layer === "harnessDefault" ? patchAll({ [spec.key]: value }) : patchMachine({ [spec.key]: value })
          }
          onInherit={() => {
            if (isStoredKey(spec.key)) patchMachine({ inherit: [spec.key] });
          }}
        />
      ))}

      <NativeSettings
        harness={harness}
        displayName={displayName}
        machine={machine}
        machineName={machineName}
        inventory={inventory}
      />
    </li>
  );
}

type StoredValue = string | readonly string[] | undefined;

const showValue = (value: StoredValue): string =>
  value === undefined ? "" : typeof value === "string" ? value : formatExtraArgs(value);

function ParamRow({
  spec,
  params,
  displayName,
  machineName,
  inventory,
  stored,
  resolvedFrom,
  resolvedValue,
  onCommit,
  onInherit,
}: {
  readonly spec: HarnessParamSpec;
  readonly params: HarnessParams;
  readonly displayName: string;
  readonly machineName: string;
  readonly inventory: HarnessInventory | undefined;
  readonly stored: Readonly<Record<SettingsLayer, StoredValue>>;
  readonly resolvedFrom: ParamLayer | undefined;
  readonly resolvedValue: StoredValue;
  readonly onCommit: (layer: SettingsLayer, value: string | readonly string[]) => void;
  /** Drop this machine's override so the All machines value applies. */
  readonly onInherit: () => void;
}) {
  const source = resolvedFrom === "machineDefault" ? machineName : "All machines";
  const effective =
    resolvedFrom === undefined || resolvedValue === undefined
      ? HARNESS_DEFAULT
      : Array.isArray(resolvedValue) && resolvedValue.length === 0
        ? `none, from ${source}`
        : showValue(resolvedValue) === ""
          ? HARNESS_DEFAULT
          : `${showValue(resolvedValue)}, from ${source}`;
  return (
    <FieldRow group label={spec.label} hint={`Seats on ${machineName} start with: ${effective}`}>
      <span className="settings-harness-layers">
        {SETTINGS_LAYERS.filter((layer) => spec.layers.includes(layer)).map((layer) => (
          <LayerControl
            key={layer}
            spec={spec}
            params={params}
            layer={layer}
            ariaLabel={`${displayName} ${spec.label.toLowerCase()}, ${layer === "machineDefault" ? machineName : "all machines"}`}
            caption={layer === "machineDefault" ? machineName : "All machines"}
            inventory={inventory}
            stored={stored[layer]}
            onCommit={(value) => onCommit(layer, value)}
            {...(layer === "machineDefault" ? { onInherit } : {})}
          />
        ))}
      </span>
    </FieldRow>
  );
}

/** The values a param offers here: its fixed list, or this machine's inventory, or its suggestions. */
const offeredValues = (spec: HarnessParamSpec, inventory: HarnessInventory | undefined): readonly string[] => {
  switch (spec.options.source) {
    case "fixed":
      return spec.options.values.filter((value) => !(spec.unoffered ?? []).includes(value));
    case "inventory":
      return inventoryOptions(inventory);
    case "free":
      return spec.options.suggestions;
  }
};

function LayerControl({
  spec,
  params,
  layer,
  ariaLabel,
  caption,
  inventory,
  stored,
  onCommit,
  onInherit,
}: {
  readonly spec: HarnessParamSpec;
  readonly params: HarnessParams;
  readonly layer: SettingsLayer;
  readonly ariaLabel: string;
  readonly caption: string;
  readonly inventory: HarnessInventory | undefined;
  readonly stored: StoredValue;
  readonly onCommit: (value: string | readonly string[]) => void;
  /** Present on a machine's own control: back to the All machines value. */
  readonly onInherit?: () => void;
}) {
  const storedText = showValue(stored);
  const [text, setText] = useState(storedText);
  const [refusal, setRefusal] = useState<string | undefined>();
  const listId = useId();
  useEffect(() => {
    setText(storedText);
    setRefusal(undefined);
  }, [storedText]);

  const offered = offeredValues(spec, inventory);
  const defaultLabel = spec.defaultValue ? `${HARNESS_DEFAULT} (${spec.defaultValue})` : HARNESS_DEFAULT;

  const commitText = (next: string): void => {
    if (spec.emit.via === "args") {
      const args = sanitizeExtraArgs(params.harness, parseExtraArgsText(next)).args;
      // Emptying a list that is set stores "none"; an empty box over nothing stores nothing.
      if (formatExtraArgs(args) !== storedText || (stored === undefined && args.length > 0)) onCommit(args);
      return;
    }
    const checked = checkParam(params, { key: spec.key, value: next, layer });
    if (Result.isFailure(checked)) {
      setRefusal(checked.failure.message);
      return;
    }
    setRefusal(undefined);
    if (checked.success !== storedText) onCommit(checked.success);
  };

  // A saved value the installed harness no longer accepts says so, and is not passed.
  const storedRefusal = (() => {
    if (typeof stored !== "string" || stored.length === 0) return undefined;
    const checked = checkParam(params, { key: spec.key, value: stored, layer });
    return Result.isFailure(checked) ? checked.failure.message : undefined;
  })();
  const argsPlaceholder =
    layer === "machineDefault" ? (stored === undefined ? "Same as all machines" : "None on this machine") : "None";

  const closedList = spec.options.source === "fixed" && !spec.custom;
  const control = closedList ? (
    <Select
      dense
      value={storedText}
      aria-label={ariaLabel}
      options={[
        { value: "", label: defaultLabel },
        ...offered.map((value) => ({ value, label: value })),
        // A saved value the list no longer offers stays visible until changed.
        ...(storedText && !offered.includes(storedText) ? [{ value: storedText, label: storedText }] : []),
      ]}
      onChange={commitText}
    />
  ) : (
    <>
      <Input
        dense
        value={text}
        list={offered.length > 0 ? listId : undefined}
        placeholder={spec.emit.via === "args" ? argsPlaceholder : defaultLabel}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => commitText(text)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitText(text);
        }}
      />
      {offered.length > 0 ? (
        <datalist id={listId}>
          {offered.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      ) : null}
    </>
  );

  const rejected = spec.emit.via === "args" ? sanitizeExtraArgs(params.harness, parseExtraArgsText(text)).rejected : [];
  return (
    <span className="settings-harness-layer" data-layer={layer}>
      <span className="settings-field__hint">{caption}</span>
      {control}
      {onInherit && stored !== undefined ? (
        <button type="button" className="settings-field__hint settings-harness-inherit" onClick={onInherit}>
          Use all machines
        </button>
      ) : null}
      {storedRefusal && !refusal ? (
        <span className="settings-field__hint" role="alert" style={{ color: HUE_TEXT.crimson }}>
          {storedRefusal}
        </span>
      ) : null}
      {refusal ? (
        <span className="settings-field__hint" role="alert" style={{ color: HUE_TEXT.crimson }}>
          {refusal}
        </span>
      ) : null}
      {rejected.map((item, index) => (
        <span key={`${item.token}-${index}`} className="settings-field__hint" role="alert">
          {item.token} is left out: {item.reason}.
        </span>
      ))}
    </span>
  );
}

type NativeValue = NativeSettingWrite["value"];

type NativeRead =
  | { readonly state: "unread" }
  | { readonly state: "answered"; readonly values: Readonly<Record<string, NativeValue>> }
  | { readonly state: "refused"; readonly message: string };

/**
 * Settings saved in the harness's own config on this machine, read and
 * written by that machine's Junto. Only keys the closed catalogue declares for
 * the machine's installed version are offered, and checkNativeSetting admits
 * every write before it is sent.
 */
function NativeSettings({
  harness,
  displayName,
  machine,
  machineName,
  inventory,
}: {
  readonly harness: HarnessId;
  readonly displayName: string;
  readonly machine: string;
  readonly machineName: string;
  readonly inventory: HarnessInventory | undefined;
}) {
  const version = inventory?.installed ? inventory.version : undefined;
  const declared = useMemo(() => nativeSettingsFor(harness, version), [harness, version]);
  const [read, setRead] = useState<NativeRead>({ state: "unread" });
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  /** Bumped to read the file again after a conflict. */
  const [readCount, setReadCount] = useState(0);
  const keys = declared.map((spec) => spec.key).join("\n");
  useEffect(() => setAnswers({}), [machine, harness]);

  useEffect(() => {
    let current = true;
    setRead({ state: "unread" });
    if (keys.length === 0) return;
    void harnessMachineSource()
      .readNativeSettings(machine, harness, keys.split("\n"))
      .then((answer) => {
        if (!current) return;
        setRead(
          Result.isSuccess(answer)
            ? { state: "answered", values: answer.success }
            : { state: "refused", message: answer.failure.message },
        );
      });
    return () => {
      current = false;
    };
  }, [machine, harness, keys, readCount]);

  const write = (spec: NativeSettingSpec, value: NativeValue): void => {
    const request: NativeSettingWrite = { machine, harness, key: spec.key, value };
    const admitted = checkNativeSetting(NATIVE_SETTINGS, request, version);
    if (Result.isFailure(admitted)) {
      setAnswers((prior) => ({ ...prior, [spec.key]: admitted.failure.message }));
      return;
    }
    void harnessMachineSource()
      .writeNativeSetting(request)
      .then((answer) => {
        if (Result.isSuccess(answer)) {
          setRead((prior) =>
            prior.state === "answered" ? { state: "answered", values: { ...prior.values, [spec.key]: answer.success } } : prior,
          );
          setAnswers(({ [spec.key]: _done, ...rest }) => rest);
        } else if (answer.failure._tag === "NativeConfigWriteError" && answer.failure.reason === "conflict") {
          // The file changed by hand: show what it holds now and let the operator choose again.
          setReadCount((count) => count + 1);
          setAnswers((prior) => ({
            ...prior,
            [spec.key]: `Not written: the file changed on ${machineName} since it was read. It now shows what is there; choose again.`,
          }));
        } else {
          setAnswers((prior) => ({ ...prior, [spec.key]: answer.failure.message }));
        }
      });
  };

  if (declared.length === 0) {
    return (
      <FieldRow group label={`Saved in ${displayName}'s own config`}>
        <span className="settings-field__hint">
          {version === undefined
            ? `Needs ${displayName}'s version on ${machineName}.`
            : `No settings are declared for ${displayName} ${version}.`}
        </span>
      </FieldRow>
    );
  }

  return (
    <div className="settings-harness-native" data-native-config={harness}>
      <span className="settings-field__hint">
        Saved in {displayName}&apos;s own config on {machineName}: changes how it runs there, in Junto and outside it.
      </span>
      {read.state === "refused" ? (
        <span className="settings-field__hint" role="status" style={{ color: HUE_TEXT.crimson }}>
          {read.message}
        </span>
      ) : null}
      {declared.map((spec) => (
        <FieldRow
          key={spec.key}
          group
          label={spec.label}
          hint={
            answers[spec.key] ? (
              <span role="alert" style={{ color: HUE_TEXT.crimson }}>
                {answers[spec.key]}
              </span>
            ) : (
              <code>{spec.key}</code>
            )
          }
        >
          <NativeControl
            spec={spec}
            ariaLabel={`${displayName} ${spec.label.toLowerCase()} in its own config on ${machineName}`}
            disabled={read.state !== "answered"}
            value={read.state === "answered" ? read.values[spec.key] : undefined}
            onWrite={(value) => write(spec, value)}
          />
        </FieldRow>
      ))}
    </div>
  );
}

const NOT_SET = "Not set in the file";

function NativeControl({
  spec,
  ariaLabel,
  disabled,
  value,
  onWrite,
}: {
  readonly spec: NativeSettingSpec;
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly value: NativeValue | undefined;
  readonly onWrite: (value: NativeValue) => void;
}) {
  const shown = value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  switch (spec.value.kind) {
    case "boolean":
      return <Switch checked={value === true} disabled={disabled} aria-label={ariaLabel} onCheckedChange={onWrite} />;
    case "enum": {
      const values = spec.value.values;
      return (
        <Select
          dense
          disabled={disabled}
          value={shown}
          aria-label={ariaLabel}
          options={[
            ...(shown === "" ? [{ value: "", label: NOT_SET }] : []),
            ...values.map((option) => ({ value: option, label: option })),
            ...(shown !== "" && !values.includes(shown) ? [{ value: shown, label: shown }] : []),
          ]}
          onChange={(next) => {
            if (next !== "" && next !== shown) onWrite(next);
          }}
        />
      );
    }
    case "string":
    case "number": {
      const numeric = spec.value.kind === "number";
      const commit = (): void => {
        const trimmed = text.trim();
        if (trimmed === "" || trimmed === shown) return;
        onWrite(numeric ? Number(trimmed) : trimmed);
      };
      return (
        <Input
          dense
          disabled={disabled}
          value={text}
          inputMode={numeric ? "decimal" : undefined}
          placeholder={NOT_SET}
          aria-label={ariaLabel}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      );
    }
  }
}
