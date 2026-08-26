import type { EtherRegionDefaults } from "@shared/canvas";
import { stripEmptyRegionPaths } from "@shared/region-defaults";
import { setRegionDefaults } from "../../lib/mutations";

export const savePathAsRegionDefault = (
  regionId: string,
  defaults: EtherRegionDefaults | undefined,
  host: string,
  path: string | undefined,
) => {
  const existing = defaults?.paths ?? {};
  const paths = { ...existing } as Record<string, string>;
  if (path?.trim()) paths[host] = path.trim();
  else delete paths[host];
  const cleanedPaths = stripEmptyRegionPaths(paths);
  const next: EtherRegionDefaults = {
    ...(defaults?.page ? { page: defaults.page } : {}),
    ...(cleanedPaths ? { paths: cleanedPaths } : {}),
  };
  setRegionDefaults(regionId, Object.keys(next).length > 0 ? next : undefined);
};

export function RegionDefaultFolderOption({
  checked,
  disabled,
  showRegionHint,
  onToggle,
  className,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly showRegionHint: boolean;
  readonly onToggle: (checked: boolean) => void;
  readonly className?: string;
}) {
  return (
    <label
      title={showRegionHint ? "Add a region to set up defaults and shared context" : undefined}
      className={[
        "flex cursor-pointer items-start gap-2 border-t border-stroke pt-3 text-[11px] leading-snug text-dim",
        disabled ? "cursor-not-allowed opacity-55" : "",
        className ?? "",
      ].join(" ")}
    >
      <input
        type="checkbox"
        className="mt-px h-4 w-4 shrink-0 accent-amber"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span>
        <span className="block text-ink">Use this folder as region default for this host</span>
        {showRegionHint ? (
          <span className="block pt-0.5 text-[10px]">Add a region to set up defaults and shared context</span>
        ) : null}
      </span>
    </label>
  );
}
