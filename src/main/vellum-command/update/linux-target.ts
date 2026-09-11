import { readFile } from "node:fs/promises";
import { updateError } from "./errors";

export interface LinuxDesktopTargetObservation {
  readonly platform: string;
  readonly architecture: string;
  readonly osRelease: string;
  readonly glibcVersion: string | undefined;
  readonly uid: number | undefined;
  readonly euid: number | undefined;
}

const ordinaryUserId = (id: number | undefined): boolean =>
  id !== undefined && Number.isSafeInteger(id) && id > 0;

/** The desktop alpha target is independent of Fleet and requires an ordinary user. */
export const assertLinuxDesktopUpdateTarget = (target: LinuxDesktopTargetObservation): void => {
  const fields = new Map(target.osRelease.split(/\r?\n/u).flatMap((line) => {
    const match = /^([A-Z_]+)=(?:"([^"\n]*)"|([^\s"']+))$/u.exec(line);
    return match === null ? [] : [[match[1]!, match[2] ?? match[3]!]];
  }));
  const glibc = /^(\d+)\.(\d+)(?:\.\d+)?$/u.exec(target.glibcVersion ?? "");
  const major = Number(glibc?.[1]);
  const minor = Number(glibc?.[2]);
  if (target.platform !== "linux" || target.architecture !== "x64" ||
    fields.get("ID") !== "ubuntu" || fields.get("VERSION_ID") !== "24.04" ||
    glibc === null || glibc[0] !== target.glibcVersion ||
    !Number.isSafeInteger(major) || !Number.isSafeInteger(minor) ||
    major !== 2 || minor !== 39) {
    throw updateError("platform-unsupported", "Linux desktop updates require Ubuntu 24.04 x64 with glibc 2.39");
  }
  if (!ordinaryUserId(target.uid) || !ordinaryUserId(target.euid)) {
    throw updateError("platform-unsupported", "Linux desktop installation and updates require an ordinary user with non-root real and effective user IDs");
  }
};

/** Native observations only: no shell, executable lookup, or privilege fallback. */
export const readLinuxDesktopTargetObservation = async (): Promise<LinuxDesktopTargetObservation> => {
  const report = process.report?.getReport() as {
    header?: { glibcVersionRuntime?: string };
  } | undefined;
  return {
    platform: process.platform,
    architecture: process.arch,
    osRelease: await readFile("/etc/os-release", "utf8"),
    glibcVersion: report?.header?.glibcVersionRuntime,
    uid: process.getuid?.(),
    euid: process.geteuid?.(),
  };
};

/** First install and the updater call this admission before network or mutation. */
export const assertCurrentLinuxDesktopTarget = async (
  observe: () => Promise<LinuxDesktopTargetObservation> = readLinuxDesktopTargetObservation,
): Promise<void> => {
  assertLinuxDesktopUpdateTarget(await observe());
};
