/**
 * Fixed cross-privilege rendezvous for Linux release maintenance.
 *
 * The root installer is the only writer. The unprivileged Remote process may
 * only observe whether the fixed path is occupied and close terminal create
 * admission while it is. Keeping this outside the user home makes a forged
 * same-UID marker impossible.
 */
export const LINUX_RELEASE_FENCE_DIRECTORY =
  "/var/lib/vellum-release-fence" as const;
export const LINUX_RELEASE_FENCE_PATH =
  "/var/lib/vellum-release-fence/active" as const;
