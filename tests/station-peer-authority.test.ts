import { realpathSync, statSync } from "node:fs";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type {
  UnixPeerProcessChain,
  UnixPeerProcessHop,
} from "../src/main/vellum/process-identity";
import {
  makeSshStationControlPeerAuthority,
  stationPeerSnapshotSatisfiesPolicy,
  type StationExecutableIdentity,
  type StationPeerPolicy,
} from "../src/main/vellum/station/peer-authority";

const station: StationExecutableIdentity = {
  path: "/opt/Vellum Command/resources/bin/vellum-station",
  device: "10",
  inode: "100",
};
const sshd: StationExecutableIdentity = {
  path: "/usr/sbin/sshd",
  device: "1",
  inode: "200",
};
const policy: StationPeerPolicy = {
  platform: "Linux",
  accountUid: 1000,
  stationExecutable: station,
  systemSshd: [sshd],
};
const executable = (identity: StationExecutableIdentity) => ({
  executable: identity.path,
  device: identity.device,
  inode: identity.inode,
});

const hop = (
  value: Partial<UnixPeerProcessHop> &
    Pick<UnixPeerProcessHop, "pid" | "ppid" | "executable" | "device" | "inode">,
): UnixPeerProcessHop => ({
  uid: 1000,
  startKey: `${value.pid}00`,
  ...value,
});

const snapshot = (
  chain: readonly UnixPeerProcessHop[],
): UnixPeerProcessChain => ({
  platform: "Linux",
  peerPid: chain[0]!.pid,
  peerUid: 1000,
  chain,
});

describe("Station SSH process authority", () => {
  it("denies a direct same-account packaged client with no sshd ancestor", () => {
    expect(
      stationPeerSnapshotSatisfiesPolicy(
        snapshot([
          hop({ pid: 50, ppid: 40, ...executable(station) }),
          hop({
            pid: 40,
            ppid: 1,
            executable: "/bin/zsh",
            device: "1",
            inode: "300",
          }),
        ]),
        policy,
      ),
    ).toBe(false);
  });

  it("denies a process merely named sshd outside the root-owned system executable", () => {
    expect(
      stationPeerSnapshotSatisfiesPolicy(
        snapshot([
          hop({ pid: 50, ppid: 40, ...executable(station) }),
          hop({
            pid: 40,
            ppid: 1,
            executable: "/tmp/sshd",
            device: sshd.device,
            inode: sshd.inode,
          }),
        ]),
        policy,
      ),
    ).toBe(false);
  });

  it("admits the exact packaged peer beneath authenticated system sshd ancestry", () => {
    expect(
      stationPeerSnapshotSatisfiesPolicy(
        snapshot([
          hop({ pid: 50, ppid: 45, ...executable(station) }),
          hop({
            pid: 45,
            ppid: 40,
            executable: "/bin/sh",
            device: "1",
            inode: "301",
          }),
          hop({ pid: 40, ppid: 1, uid: 0, ...executable(sshd) }),
        ]),
        policy,
      ),
    ).toBe(true);
  });

  it("denies an arbitrary SSH-session program even below real sshd", () => {
    expect(
      stationPeerSnapshotSatisfiesPolicy(
        snapshot([
          hop({
            pid: 50,
            ppid: 40,
            executable: "/bin/sh",
            device: "1",
            inode: "301",
          }),
          hop({ pid: 40, ppid: 1, uid: 0, ...executable(sshd) }),
        ]),
        policy,
      ),
    ).toBe(false);
  });

  it("requires an identical fresh epoch observation before dispatch", () => {
    const stationPath = realpathSync(process.execPath);
    const sshdPath = realpathSync("/usr/sbin/sshd");
    const stationMetadata = statSync(stationPath, { bigint: true });
    const sshdMetadata = statSync(sshdPath, { bigint: true });
    const platform =
      process.platform === "darwin" ? "Darwin" as const : "Linux" as const;
    const uid = process.getuid!();
    const admitted: UnixPeerProcessChain = {
      platform,
      peerPid: 50,
      peerUid: uid,
      chain: [{
        pid: 50,
        ppid: 40,
        uid,
        startKey: "100",
        executable: stationPath,
        device: stationMetadata.dev.toString(10),
        inode: stationMetadata.ino.toString(10),
      }, {
        pid: 40,
        ppid: 1,
        uid: 0,
        startKey: "200",
        executable: sshdPath,
        device: sshdMetadata.dev.toString(10),
        inode: sshdMetadata.ino.toString(10),
      }],
    };
    let current = admitted;
    const authority = makeSshStationControlPeerAuthority({
      stationExecutablePath: stationPath,
      readProcessChain: () => current,
    });
    const socket = {} as Socket;
    const proof = authority.capture(socket);
    expect(proof).toBeDefined();
    expect(authority.revalidate(socket, proof!)).toBe(true);

    current = {
      ...admitted,
      chain: [
        { ...admitted.chain[0]! },
        { ...admitted.chain[1]!, startKey: "201" },
      ],
    };
    expect(authority.revalidate(socket, proof!)).toBe(false);
  });
});
