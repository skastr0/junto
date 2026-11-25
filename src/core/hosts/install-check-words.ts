import type { MachineInstallCheck, MachineInstallError } from "@shared/machine-install";

/**
 * This core's own sentence for each far install refusal code
 * (docs/plans/0.11/machines-attention-look.md, section 6). No path, no host
 * name and no far text: the far machine is "it" or "there", and "this
 * machine" is the one sending.
 */
const WORDS: Readonly<Record<MachineInstallCheck, string>> = {
  "boat-key-not-placed": "Its machine key could not be written there. Check it again.",
  "bundle-manifest-invalid": "The package from this machine has a list of files that cannot be read. Update Junto on this machine, then send again.",
  "bundle-mismatch": "The files that arrived did not match the package. Send Junto again.",
  "bundle-not-directory": "What arrived there was not a Junto package. Send Junto again.",
  "bundle-special-file": "The package from this machine holds a link or a special file. Update Junto on this machine, then send again.",
  "bundle-writable-by-others": "The package from this machine has files others can change. Update Junto on this machine, then send again.",
  "core-mismatch": "The Junto running there is not the one just installed. Check it again.",
  "database-copy-failed": "Junto could not keep a copy of its data there, so nothing changed. Check it again.",
  "database-not-private": "Its Junto data is not private to its account, so nothing changed. Check it again.",
  "home-lock-refused": "Its Junto home is held by another Junto or another account. Check it again.",
  "install-folder-not-ours": "Its install folder belongs to another Junto. Remove it, then add it again with another install folder.",
  "install-lease-unavailable": "Junto could not take the install lock there. Check it again.",
  "installation-changed": "The new build is installed there but answers as a different install of Junto, so Junto stopped it. Preview a take-over with junto machine takeover to see which seats and automations move.",
  "installed-not-started": "The new build is installed there but did not start, and nothing runs there now. Update Junto on this machine, then send again.",
  "machine-path-unsafe": "A Junto folder there is outside its home or not private. Check it again.",
  "restore-finish-blocked": "Junto could not finish restoring its data there. Its data is kept. Send Junto again.",
  "restore-interrupted": "An earlier restore of its data did not finish. Check it again before you send Junto.",
  "restore-owed": "Its data still waits for a restore, which finishes when Junto starts there. Check it again.",
  "running-seats-unreported": "Junto there did not say how many seats it runs. Check it again before you update.",
  "seats-did-not-stop": "A seat there did not stop when asked. Check it again before you update.",
  "send-in-progress": "Junto is already being sent there. Send again when that send ends.",
  "service-not-ours": "The Junto service there belongs to another install. Check it again.",
  "service-not-quiescent": "The old Junto there did not stop. Check it, then send Junto again.",
  "service-platform-unsupported": "Junto runs on macOS and Linux machines only. Remove it from your machines.",
  "start-and-restore-failed": "The new build did not start, and its data was not restored. Check it again.",
  "start-failed": "Junto did not start there, and it is not confirmed stopped. Check it again before you send.",
  "start-rolled-back": "The new build did not start there. The old build and its data are back, but it may not be running. Check it again before you update.",
  "status-unreadable": "Junto there did not report its status. Check it again.",
};

const NOTHING_CHANGED = ", so nothing changed";
/** installation-changed after a rollback (remote-design, ce8e8756f). */
const INSTALLATION_CHANGED_ROLLED_BACK = "It answers as a different install of Junto, so Junto put its old build and data back, but the old build may not be running. Preview a take-over with junto machine takeover to see which seats and automations move.";
/** installation-changed when this side cannot confirm the stop (remote-design, 5562e0a78). */
const INSTALLATION_CHANGED_UNSTOPPED = "The new build is installed there but answers as a different install of Junto, and it may still be running. Preview a take-over with junto machine takeover to see which seats and automations move.";

/**
 * The words for a code, under the disposition this side decoded. A sentence
 * claims an outcome only where the disposition says so; a code whose claim
 * the disposition does not carry has no words, and the far text stays.
 */
export const installCheckWords = (
  check: MachineInstallCheck,
  disposition: MachineInstallError["disposition"],
): string | undefined => {
  const words = WORDS[check];
  switch (check) {
    case "database-copy-failed":
    case "database-not-private":
      return disposition === "staged" || disposition === "rolled-back" ? words : words.replace(NOTHING_CHANGED, "");
    case "installed-not-started":
      return disposition === "activated" ? words : "The new build did not start there. Update Junto on this machine, then send again.";
    case "start-rolled-back":
      return disposition === "rolled-back" ? words : undefined;
    // By disposition (look doc section 5, ce8e8756f): activated is a confirmed stop of the new build, rolled-back
    // put the old one back but its restart is best-effort, uncertain may still run. Anything else claims nothing.
    case "installation-changed":
      return disposition === "activated" ? words
        : disposition === "rolled-back" ? INSTALLATION_CHANGED_ROLLED_BACK
        : disposition === "uncertain" ? INSTALLATION_CHANGED_UNSTOPPED
        : undefined;
    default:
      return words;
  }
};
