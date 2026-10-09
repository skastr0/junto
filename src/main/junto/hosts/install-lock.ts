import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureMachineDirectory, machineHomePath, ownedMachineFile } from "./install-paths";

declare const lockRootBrand: unique symbol;
export interface OwnedInstallLockRoot { readonly [lockRootBrand]: true }
const roots = new WeakMap<OwnedInstallLockRoot, string>();

// The kernel releases the lease when this helper exits. EOF on its private
// input closes it even if the installer crashes, without deleting a lock that
// a concurrent installer may already own.
const HOLD_LOCK = `import fcntl, os, stat, sys
try:
    fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_nlink != 1 or metadata.st_mode & 0o077:
        raise RuntimeError("The install lock is not owned by Junto. Choose another install folder")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("Junto is already being sent to this machine. Wait for it to finish, then send again")
    print("locked", flush=True)
    sys.stdin.buffer.read()
    os.close(fd)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

/** Only an installation's exact owner marker admits its lock directory. */
export const admitInstallLockRoot = async (root: string, expectedOwner: string): Promise<OwnedInstallLockRoot> => {
  await machineHomePath(root);
  const marker = join(root, "owner.json");
  if (!await ownedMachineFile(marker) || await readFile(marker, "utf8") !== expectedOwner) throw new Error("This folder belongs to another Junto installation");
  const handle = Object.freeze({}) as OwnedInstallLockRoot;
  roots.set(handle, root);
  return handle;
};

export const acquireInstallLock = async (handle: OwnedInstallLockRoot): Promise<() => Promise<void>> => {
  const root = roots.get(handle);
  if (root === undefined) throw new Error("Install lock requires an owned installation");
  const directory = join(root, ".install-lock");
  // An empty directory left by the old installer is a valid lease anchor.
  await ensureMachineDirectory(directory);
  const file = join(directory, "lease");
  await ownedMachineFile(file);
  let python: string | undefined;
  for (const candidate of ["/usr/bin/python3", "/bin/python3"]) {
    try { await access(candidate, constants.X_OK); python = candidate; break; } catch { /* Try the other trusted system path. */ }
  }
  if (python === undefined) throw new Error("Install Python 3 on this machine, then send Junto again");
  const child = spawn(python, ["-c", HOLD_LOCK, file], { stdio: ["pipe", "pipe", "pipe"] });
  let detail = "";
  child.stderr.on("data", bytes => { detail = (detail + String(bytes)).slice(0, 4096); });
  child.stdin.on("error", () => { /* An exited helper is reported by its exit result. */ });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(detail.trim() || "Cannot acquire the Junto install lock. Send again")));
  });
  void exited.catch(() => {});
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", bytes => {
      output += String(bytes);
      if (output === "locked\n") resolve();
      else if (output.length > 64) reject(new Error("Invalid Junto install lock response"));
    });
    void exited.then(() => reject(new Error("Junto install lock closed before admission")), reject);
  });
  try { await ready; }
  catch (cause) { child.stdin.end(); await exited.catch(() => {}); throw cause; }
  return async () => { child.stdin.end(); await exited; };
};
