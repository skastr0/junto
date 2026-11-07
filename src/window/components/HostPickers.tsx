/**
 * Shared machine and browser-profile Selects for node and region config.
 */
import { useEffect, useState } from "react";
import type { BrowserProfileInfo, JuntoApi, JuntoBrowserApi, JuntoTerminalApi } from "@shared/ipc";
import { Select } from "./ui";
import { getJuntoApi } from "../lib/junto-api";

type HostOpt = { readonly value: string; readonly label: string };
type BrowserApi = (JuntoApi & Partial<JuntoTerminalApi> & Partial<JuntoBrowserApi>) | undefined;

/** Why the machine a row already names is not among the ones offered. */
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
