import { Command, Flag } from "effect/unstable/cli";
import { Effect } from "effect";
import { verifyLinuxDesktopReleaseFiles } from "../../shared/linux-desktop-release-files";
import {
  stageLinuxDesktopRelease,
  revalidateLinuxDesktopRelease,
  activateLinuxDesktopRelease,
  assertLinuxDesktopFirstInstallAvailable,
} from "../../main/vellum/update/linux-install";
import { assertCurrentLinuxDesktopTarget } from "../../main/vellum/update/linux-target";
import { WireError } from "../core/errors";
import { executeJsonCommand } from "../core/output";

export const installLinuxDesktop = async (input: {
  readonly release: string;
  readonly archive: string;
  readonly sources: string;
}) => {
  await assertCurrentLinuxDesktopTarget();
  await assertLinuxDesktopFirstInstallAvailable({});
  const descriptor = await verifyLinuxDesktopReleaseFiles({
    releasePath: input.release,
    archivePath: input.archive,
    sourceIndexPath: input.sources,
  });
  const staged = await stageLinuxDesktopRelease({ archivePath: input.archive, descriptor });
  await revalidateLinuxDesktopRelease(staged);
  await activateLinuxDesktopRelease(staged, { mode: "first-install" });
  return {
    version: descriptor.version,
    archive_sha256: staged.archiveSha256,
    executable_path: staged.executablePath,
    launched: false,
    next_step: "Close any running Vellum Command app, then open ~/.local/bin/vellum-command-desktop. Future updates are installed from the app.",
  };
};

export const desktopInstallCommand = Command.make("desktop-install", {
  release: Flag.string("release").pipe(Flag.withDescription("Downloaded signed release.json")),
  archive: Flag.string("archive").pipe(Flag.withDescription("Downloaded Linux x64 runtime archive")),
  sources: Flag.string("sources").pipe(Flag.withDescription("Matching corresponding-source sources.json")),
}, (input) => executeJsonCommand("desktop-install", Effect.tryPromise({
  try: () => installLinuxDesktop(input),
  catch: (cause) => new WireError({
    type: "LinuxDesktopInstallError",
    message: cause instanceof Error ? cause.message : String(cause),
    details: { next_step: "Check the signed release inputs and supported host. An existing managed installation must update through the app." },
  }),
}))).pipe(Command.withDescription("Create the first verified Linux desktop installation without launching it"));
