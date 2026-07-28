#!/bin/sh
# Refuse to claim an administrator-owned AppArmor path before dpkg unpacks.
set -eu

requires_preflight=0
case "${1:-}" in
  install)
    if [ "$#" -eq 1 ]; then
      # Only a never-installed host has no incumbent package transaction to
      # protect. Package removal deliberately preserves the root journal
      # directory, so a later reinstall cannot masquerade as first install.
      if [ -e /var/lib/vellum-release-installer ] ||
         [ -L /var/lib/vellum-release-installer ]; then
        requires_preflight=1
      fi
    elif [ "$#" -ne 3 ]; then
      printf 'vellum: malformed package installation phase\n' >&2
      exit 1
    else
      requires_preflight=1
    fi
    ;;
  upgrade)
    if [ "$#" -ne 3 ]; then
      printf 'vellum: malformed package upgrade phase\n' >&2
      exit 1
    fi
    requires_preflight=1
    ;;
  abort-upgrade)
    # dpkg is unwinding to the incumbent. Do not turn recovery into a second
    # package admission decision.
    exit 0
    ;;
  *)
    printf 'vellum: unsupported package pre-installation phase: %s\n' "${1:-missing}" >&2
    exit 1
    ;;
esac

if [ "$requires_preflight" -eq 1 ]; then
  # The new preinst runs before candidate bytes are unpacked. It therefore
  # authorizes an installed-state transition only from the root journal and
  # the exact systemd cgroup minted by vellum-release-installer. No
  # environment variable, home path, package-manager command line, or
  # additional marker can grant this transition.
  /usr/bin/python3 - "$1" "${2:-}" "${3:-}" <<'PY'
import json
import os
import re
import stat
import sys

JOURNAL_SCHEMA = "vellum/linux-release-installer-journal/v4"
TRANSACTION = re.compile(r"^[0-9a-f]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
BOOT_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
TOP_LEVEL_KEYS = {
    "schema",
    "transactionId",
    "operation",
    "owner",
    "target",
    "fence",
    "manifestSha256",
    "debSha256",
    "sourceRevision",
    "fromVersion",
    "toVersion",
    "phase",
}


def fail() -> None:
    raise ValueError("installed package transition lacks exact Vellum preflight authority")


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail()
        value[key] = item
    return value


def read_exact_journal():
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW
    root = os.open("/var/lib/vellum-release-installer", directory_flags)
    try:
        root_stat = os.fstat(root)
        if (
            not stat.S_ISDIR(root_stat.st_mode)
            or root_stat.st_uid != 0
            or root_stat.st_gid != 0
            or stat.S_IMODE(root_stat.st_mode) != 0o700
        ):
            fail()
        journal = os.open("transaction.json", file_flags, dir_fd=root)
        try:
            journal_stat = os.fstat(journal)
            if (
                not stat.S_ISREG(journal_stat.st_mode)
                or journal_stat.st_uid != 0
                or journal_stat.st_gid != 0
                or stat.S_IMODE(journal_stat.st_mode) != 0o600
                or journal_stat.st_nlink != 1
                or journal_stat.st_size < 2
                or journal_stat.st_size > 65536
            ):
                fail()
            encoded = os.read(journal, 65537)
            if len(encoded) != journal_stat.st_size:
                fail()
        finally:
            os.close(journal)
    finally:
        os.close(root)

    try:
        text = encoded.decode("utf-8")
        value = json.loads(text, object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail()
    if (
        not isinstance(value, dict)
        or set(value) != TOP_LEVEL_KEYS
        or json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n" != text
    ):
        fail()
    return value


def prove_owner(owner) -> None:
    if (
        not isinstance(owner, dict)
        or set(owner) != {"pid", "startTicks", "bootId"}
        or type(owner["pid"]) is not int
        or owner["pid"] < 1
        or owner["pid"] > 0x7FFFFFFF
        or not isinstance(owner["startTicks"], str)
        or re.fullmatch(r"(0|[1-9][0-9]{0,19})", owner["startTicks"]) is None
        or not isinstance(owner["bootId"], str)
        or BOOT_ID.fullmatch(owner["bootId"]) is None
    ):
        fail()
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as source:
            if source.read().strip() != owner["bootId"]:
                fail()
        with open(f'/proc/{owner["pid"]}/stat', encoding="ascii") as source:
            process_stat = source.read()
    except (FileNotFoundError, PermissionError, OSError):
        fail()
    command_end = process_stat.rfind(")")
    fields = process_stat[command_end + 2 :].split() if command_end > 0 else []
    if len(fields) < 20 or fields[19] != owner["startTicks"]:
        fail()


def main() -> None:
    action, old_version, new_version = sys.argv[1:]
    if action == "upgrade":
        if (
            VERSION.fullmatch(old_version) is None
            or VERSION.fullmatch(new_version) is None
        ):
            fail()
    elif action == "install":
        if (old_version == "") != (new_version == ""):
            fail()
        if old_version != "" and (
            VERSION.fullmatch(old_version) is None
            or VERSION.fullmatch(new_version) is None
        ):
            fail()
    else:
        fail()
    journal = read_exact_journal()
    transaction_id = journal.get("transactionId")
    deb_sha256 = journal.get("debSha256")
    if (
        journal.get("schema") != JOURNAL_SCHEMA
        or journal.get("operation") != "install"
        or journal.get("phase") != "dpkg-started"
        or not isinstance(transaction_id, str)
        or TRANSACTION.fullmatch(transaction_id) is None
        or not isinstance(deb_sha256, str)
        or SHA256.fullmatch(deb_sha256) is None
        or (
            new_version != ""
            and journal.get("toVersion") != new_version
        )
        or (
            action == "upgrade"
            and journal.get("fromVersion") != old_version
        )
        or (
            action == "install"
            and journal.get("fromVersion") is not None
        )
    ):
        fail()
    prove_owner(journal.get("owner"))
    unit = f"0::/system.slice/vellum-release-install-{transaction_id}.service"
    try:
        with open("/proc/self/cgroup", encoding="ascii") as source:
            cgroups = source.read().splitlines()
    except (FileNotFoundError, PermissionError, OSError):
        fail()
    if unit not in cgroups:
        fail()


try:
    main()
except (KeyError, OSError, TypeError, ValueError):
    print(
        "vellum: refusing an installed package change without the exact "
        "sealed candidate preflight transaction",
        file=sys.stderr,
    )
    sys.exit(1)
PY
fi

PROFILE_SOURCE='/opt/Vellum Command/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_SOURCE='/opt/Vellum Command/resources/systemd/vellum-remote.service'
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'
INSTALLER_TARGET='/usr/libexec/vellum-release-installer'
BRIDGE_TARGET='/usr/libexec/vellum-release-bridge'
BRIDGE_STAGE_ROOT='/var/tmp/vellum-release-bridge'
SUDOERS_TARGET='/etc/sudoers.d/vellum-release-installer'
INSTALLER_STATE='/var/lib/vellum-release-installer'
BRIDGE_STAGE_MARKER="$INSTALLER_STATE/packaged-bridge-stage-root"
BRIDGE_STAGE_MARKER_VALUE='vellum/linux-release-bridge-stage-root/v1'

qualify_root_file_if_present() {
  target="$1"
  expected_mode="$2"
  label="$3"
  if [ -L "$target" ]; then
    printf 'vellum: refusing a symlink at the %s boundary\n' "$label" >&2
    exit 1
  fi
  if [ -e "$target" ] && {
    [ ! -f "$target" ] ||
    [ "$(stat -c '%u:%g:%a:%h' "$target" 2>/dev/null || true)" != "0:0:$expected_mode:1" ]
  }; then
    printf 'vellum: refusing an unsafe existing %s\n' "$label" >&2
    exit 1
  fi
}

qualify_root_file_if_present "$INSTALLER_TARGET" 755 'release installer'
qualify_root_file_if_present "$BRIDGE_TARGET" 755 'release bridge'
qualify_root_file_if_present "$SUDOERS_TARGET" 440 'release installer sudoers policy'

if [ -L "$BRIDGE_STAGE_ROOT" ]; then
  printf 'vellum: refusing a release bridge stage-root symlink\n' >&2
  exit 1
fi
if [ -e "$BRIDGE_STAGE_ROOT" ]; then
  if [ ! -d "$BRIDGE_STAGE_ROOT" ] ||
     [ "$(stat -c '%u:%g:%a' "$BRIDGE_STAGE_ROOT" 2>/dev/null || true)" != '0:0:1733' ] ||
     [ -L "$BRIDGE_STAGE_MARKER" ] || [ ! -f "$BRIDGE_STAGE_MARKER" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$BRIDGE_STAGE_MARKER" 2>/dev/null || true)" != '0:0:600:1' ] ||
     [ "$(/bin/cat "$BRIDGE_STAGE_MARKER" 2>/dev/null || true)" != "$BRIDGE_STAGE_MARKER_VALUE" ]; then
    printf 'vellum: refusing a foreign release bridge stage root\n' >&2
    exit 1
  fi
elif [ -e "$BRIDGE_STAGE_MARKER" ] || [ -L "$BRIDGE_STAGE_MARKER" ]; then
  printf 'vellum: refusing a release bridge stage marker without its root\n' >&2
  exit 1
fi

if [ -L "$PROFILE_TARGET" ]; then
  if [ "$(readlink "$PROFILE_TARGET")" != "$PROFILE_SOURCE" ]; then
    printf 'vellum: refusing an AppArmor link not owned by this package\n' >&2
    exit 1
  fi
elif [ -e "$PROFILE_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned AppArmor profile\n' >&2
  exit 1
fi

# The canonical discovery path is a qualified link to the immutable package
# asset. Do not replace an administrator's unit or a link owned elsewhere.
if [ -L "$UNIT_TARGET" ]; then
  if [ "$(readlink "$UNIT_TARGET")" != "$UNIT_SOURCE" ]; then
    printf 'vellum: refusing a systemd user unit link not owned by this package\n' >&2
    exit 1
  fi
elif [ -e "$UNIT_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned systemd user unit\n' >&2
  exit 1
fi
