/**
 * Shared enrolled-host + browser-profile Selects for node/region config.
 */
import { useEffect, useState } from "react";
import type { BrowserProfileInfo, VellumCommandApi, VellumCommandBrowserApi, VellumCommandTerminalApi } from "@shared/ipc";
import { Select } from "./ui";
import { getJuntoApi } from "../lib/junto-api";

type HostOpt = { readonly value: string; readonly label: string };
type BrowserApi = (VellumCommandApi & Partial<VellumCommandTerminalApi> & Partial<VellumCommandBrowserApi>) | undefined;

export function EnrolledHostSelect({
  value,
  onChange,
  ariaLabel,
  /** When set, only hosts advertising this capability (e.g. browser). */
  capability,
  dense = true,
  placeholder = "select host…",
}: {
  readonly value: string;
  readonly onChange: (hostId: string) => void;
  readonly ariaLabel: string;
  readonly capability?: string;
  readonly dense?: boolean;
  readonly placeholder?: string;
}) {
  const [options, setOptions] = useState<ReadonlyArray<HostOpt>>([]);

  useEffect(() => {
    let current = true;
    void getJuntoApi()
      ?.hostsList?.()
      .then((result) => {
        if (!current || !result?.ok || !Array.isArray(result.hosts)) return;
        const seen = new Set<string>();
        const enrolled = result.hosts
          .filter((candidate) => {
            if (typeof candidate.id !== "string" || !candidate.id) return false;
            if (seen.has(candidate.id)) return false;
            seen.add(candidate.id);
            if (capability && !candidate.capabilities?.includes(capability)) return false;
            return true;
          })
          .map((candidate) => ({
            value: candidate.id,
            label:
              candidate.label === candidate.id || !candidate.label
                ? candidate.id
                : `${candidate.label} (${candidate.id})`,
          }));
        setOptions(
          value && !enrolled.some((opt) => opt.value === value)
            ? [{ value, label: `${value} (unavailable)` }, ...enrolled]
            : enrolled,
        );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [value, capability]);

  // Host is always a real enrolled id when set. Empty value = not chosen yet
  // (placeholder), never a "none" option.
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
