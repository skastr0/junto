#!/usr/bin/env python3
"""Restore the exact lol-html registry sources for offline Cargo resolution.

Usage: python3 restore-cargo-sources.py SOURCE_DOWNLOAD_DIRECTORY NEW_DIRECTORY
This verifies the versioned catalog before extracting. It never downloads code,
changes Cargo's global configuration, or builds a binary.
"""
import hashlib
import json
import pathlib
import sys
import tarfile


def digest(file):
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def restore(download_directory, destination):
    catalog = json.loads(pathlib.Path(__file__).with_name("runtime-source-catalog.json").read_text())
    crates = [entry for entry in catalog if entry["id"].startswith("rust-")]
    if len(crates) != 43:
        raise ValueError("expected the complete pinned lol-html Cargo.lock registry set")
    # Check every archive before creating the destination. Source downloads may
    # share a directory with the release index and the application source.
    for entry in crates:
        file = download_directory / entry["file"]
        if file.is_symlink() or not file.is_file() or file.stat().st_size != entry["bytes"]:
            raise ValueError("invalid source file: " + entry["file"])
        if digest(file) != entry["sha256"]:
            raise ValueError("source checksum differs: " + entry["file"])
    destination.mkdir(mode=0o700)  # A new local directory only; never overwrite.
    vendor = destination / "vendor"
    vendor.mkdir()
    for entry in crates:
        root_name = entry["id"].removeprefix("rust-")
        with tarfile.open(download_directory / entry["file"], "r:gz") as archive:
            members = archive.getmembers()
            for member in members:
                parts = pathlib.PurePosixPath(member.name).parts
                if (not parts or parts[0] != root_name or ".." in parts
                        or pathlib.PurePosixPath(member.name).is_absolute()
                        or not (member.isfile() or member.isdir())):
                    raise ValueError("unsafe crate archive member: " + member.name)
            # Only validated regular files and directories in a fresh tree.
            for member in members:
                output = vendor / member.name
                if member.isdir():
                    output.mkdir(parents=True, exist_ok=True)
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, output.open("xb") as target:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            target.write(chunk)
        root = vendor / root_name
        files = {
            str(file.relative_to(root)): digest(file)
            for file in sorted(root.rglob("*")) if file.is_file()
        }
        (root / ".cargo-checksum.json").write_text(json.dumps({
            "files": files,
            "package": entry["sha256"],
        }, sort_keys=True) + "\n")
    config = destination / "cargo-source-config.toml"
    config.write_text(
        '[source.crates-io]\nreplace-with = "release-sources"\n'
        '[source.release-sources]\ndirectory = ' + json.dumps(str(vendor.resolve())) + "\n"
        '[net]\noffline = true\n'
    )
    print(config)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    restore(pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).absolute())
