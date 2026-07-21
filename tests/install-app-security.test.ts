import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const install = readFileSync(join(root, "scripts/install-app.sh"), "utf8");
const paths = readFileSync(join(root, "scripts/app-paths.sh"), "utf8");
const launchd = readFileSync(join(root, "scripts/install-launchd.sh"), "utf8");

const position = (source: string, needle: string): number => {
  const index = source.indexOf(needle);
  expect(index, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe("hardened app installer", () => {
  it("audits candidate, staged, and installed copies before declaring success", () => {
    const candidate = position(install, 'audit_app_bundle "$APP_SRC"');
    const stageCopy = position(install, 'ditto --rsrc "$APP_SRC" "$STAGE"');
    const staged = position(install, 'audit_app_bundle "$STAGE"');
    const quiesce = position(install, "unload_launchd");
    const replace = position(install, 'mv "$STAGE" "$APP_DST"');
    const installed = position(install, 'audit_app_bundle "$APP_DST"');
    const success = position(install, 'log "installed $APP_DST"');

    expect(candidate).toBeLessThan(stageCopy);
    expect(stageCopy).toBeLessThan(staged);
    expect(staged).toBeLessThan(quiesce);
    expect(quiesce).toBeLessThan(replace);
    expect(replace).toBeLessThan(installed);
    expect(installed).toBeLessThan(success);
  });

  it("preserves the source override and makes skip-build use the same audit path", () => {
    expect(paths).toContain('APP_SRC="${VELLUM_APP_SRC:-$(detect_app_src)}"');
    expect(install).not.toContain('APP_SRC="$(detect_app_src)"');
    expect(install.match(/audit_app_bundle "\$APP_SRC"/gu)).toHaveLength(1);
    expect(position(install, 'if [[ "$SKIP_BUILD" -eq 0 ]]')).toBeLessThan(
      position(install, 'audit_app_bundle "$APP_SRC"'),
    );
  });

  it("refuses live processes and never removes the installed app in place", () => {
    expect(paths).toContain("vellum_processes_running");
    expect(paths).toContain("refusing to replace the app");
    expect(paths).not.toContain("will overwrite app bundle anyway");
    expect(install).toContain("if launchd_loaded || vellum_processes_running");
    expect(install).not.toContain('rm -rf "$APP_DST"');
  });

  it("uses same-filesystem rollback and verifies copy identity by CDHash", () => {
    expect(install).toContain('STAGE_ROOT="${APP_DST}.new.$$"');
    expect(install).toContain('STAGE="$STAGE_ROOT/$(basename "$APP_DST")"');
    expect(position(install, 'mkdir -p "$STAGE_ROOT"')).toBeLessThan(
      position(install, 'ditto --rsrc "$APP_SRC" "$STAGE"'),
    );
    expect(install).toContain('rm -rf "$STAGE_ROOT"');
    expect(install).toContain('BACKUP="${APP_DST}.previous.$$"');
    expect(install).toContain('mv "$APP_DST" "$BACKUP"');
    expect(install).toContain("rollback_previous_app");
    expect(install).toContain('if [[ "$STAGED_CDHASH" != "$CANDIDATE_CDHASH" ]]');
    expect(install).toContain('if [[ "$INSTALLED_CDHASH" != "$CANDIDATE_CDHASH" ]]');
    expect(position(install, 'audit_app_bundle "$APP_DST"')).toBeLessThan(
      install.lastIndexOf("\ninstall_browser_cli\n"),
    );
  });

  it("routes supervised installation through the hardened installer", () => {
    expect(launchd).toContain('bash "$SCRIPT_DIR/install-app.sh"');
    expect(launchd).toContain('bash "$SCRIPT_DIR/install-app.sh" --skip-build');
    expect(position(install, 'audit_app_bundle "$APP_DST"')).toBeLessThan(
      position(install, 'bash "$SCRIPT_DIR/install-launchd.sh" --skip-build'),
    );
  });

  it("documents supervisedPreferred as product intent, not auto-read by install", () => {
    expect(install).toContain("settings.station.supervisedPreferred");
    expect(install).toContain("does NOT read ~/.vellum/settings.json");
    expect(launchd).toContain("settings.station.supervisedPreferred");
    expect(launchd).toContain("does not read");
  });
});
