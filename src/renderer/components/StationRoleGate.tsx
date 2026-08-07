/**
 * Station role onboarding UI is retired for v1.
 *
 * Fresh unpaired installs auto-establish as the local Command Center in
 * SettingsService (`ensureDefaultCommandCenter`). Remote identity is never a
 * first-run choice — only a future Station-API pairing path.
 *
 * This module remains as a no-op export so architecture tests and import
 * archaeology have a single place documenting the decision.
 */
export function StationRoleGate(): null {
  return null;
}
