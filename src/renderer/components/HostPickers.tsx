/**
 * Shared machine and browser-profile Selects for node and region config.
 */
import { useEffect, useState } from "react";
import type { BrowserProfileInfo, JuntoApi, JuntoBrowserApi, JuntoTerminalApi } from "@shared/ipc";
import { hostHasCapability, type HostCapability, type RemoteHost } from "@shared/remote-hosts";
import { Select } from "./ui";
import { getJuntoApi } from "../lib/junto-api";
import { loadSetUpMachines, machineLabel } from "../lib/machines";
import { state$ } from "../lib/state";

type HostOpt = { readonly value: string; readonly label: string };
type BrowserApi = (JuntoApi & Partial<JuntoTerminalApi> & Partial<JuntoBrowserApi>) | undefined;

/** Why the machine a row already names is not among the ones offered. */
const whyNotOffered = (name: string, setUp: ReadonlyArray<RemoteHost>): string => {
  if (!state$.machines.peek().some((machine) => machine.id === name)) return "not in your machines";
  return setUp.some((machine) => machine.id === name) ? "cannot do this" : "not set up";
};

export function MachineSelect({
  value,
  onChange,
  ariaLabel,
  /** When set, only machines that say they can do this (for example, run a browser). */
  capability,
  dense = true,
  placeholder = "Choose a machine",
}: {
  readonly value: string;
  readonly onChange: (hostId: string) => void;
  readonly ariaLabel: string;
  readonly capability?: HostCapability;
  readonly dense?: boolean;
  readonly placeholder?: string;
}) {
  const [options, setOptions] = useState<ReadonlyArray<HostOpt>>([]);

  useEffect(() => {
    let current = true;
    // Only a machine that is set up can be chosen.
    void loadSetUpMachines().then((machines) => {
      if (!current) return;
      const offered = machines
        .filter((machine) => !capability || hostHasCapability(machine, capability))
        .map((machine) => ({ value: machine.id, label: machine.label.trim() || machine.id }));
      setOptions(
        value && !offered.some((option) => option.value === value)
          ? [{ value, label: `${machineLabel(value)} (${whyNotOffered(value, machines)})` }, ...offered]
          : offered,
      );
    });
    return () => {
      current = false;
    };
  }, [value, capability]);

  // A machine is always a real name when set. Empty means not chosen yet
  // (the placeholder), never a "none" option.
  return (
    <Select
      dense={dense}
      aria-label={ariaLabel}
      value={value}
      options={options}
      placeholder={placeholder}
      onChange={onChange}
    />
  );
}

export function BrowserProfileSelect({
  value,
  onChange,
  ariaLabel,
  allowNone = false,
  noneLabel = "none",
  dense = true,
}: {
  readonly value: string;
  readonly onChange: (profileId: string) => void;
  readonly ariaLabel: string;
  readonly allowNone?: boolean;
  readonly noneLabel?: string;
  readonly dense?: boolean;
}) {
  const [options, setOptions] = useState<ReadonlyArray<HostOpt>>([
    { value: "personal", label: "personal" },
    { value: "work", label: "work" },
  ]);

  useEffect(() => {
    let current = true;
    const api = getJuntoApi() as BrowserApi;
    void api
      ?.browserProfiles?.()
      .then((result) => {
        if (!current || !result?.ok || !result.data) return;
        const listed = result.data
          .filter((p: BrowserProfileInfo) => typeof p.id === "string" && p.id.length > 0)
          .map((p: BrowserProfileInfo) => ({
            value: p.id,
            label: p.label?.trim() || p.id,
          }));
        if (listed.length === 0) return;
        setOptions(
          value && !listed.some((opt: HostOpt) => opt.value === value)
            ? [{ value, label: `${value} (unavailable)` }, ...listed]
            : listed,
        );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [value]);

  return (
    <Select
      dense={dense}
      aria-label={ariaLabel}
      value={value}
      options={[
        ...(allowNone ? [{ value: "", label: noneLabel }] : []),
        ...options,
      ]}
      onChange={onChange}
    />
  );
}
