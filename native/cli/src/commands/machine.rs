//! `machine` over the operator socket (src/cli/commands/machine.ts): the
//! owner installs and manages Junto on machines. A seat is refused before
//! parsing (main.rs). What runs on the target machine's own files, install,
//! uninstall and a Boat machine's key, is the bundle's Node entry
//! (src/main/junto/hosts/machine-local.ts); this binary hands those to it.

use std::io::{IsTerminal, Read};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Run;
use super::logs::{Filters, Query};
use crate::envelope::{self, Answer};
use crate::error::{ErrorType, Failure, Result};
use crate::{features, input, operator};

/// Install and manage Junto on machines
#[derive(Args)]
pub struct Machine {
    #[command(subcommand)]
    command: Command,
}

/// One JSON object, `@file`, or `-` for stdin.
#[derive(Args)]
struct Input {
    input: String,
}

#[derive(Args)]
struct SeatRef {
    canvas: String,
    seat: String,
}

#[derive(Subcommand)]
enum Command {
    InstallLocal(Input),
    UninstallLocal(Input),
    BoatKeyLocal,
    Add(Input),
    List(Input),
    Send(Input),
    Status(Input),
    Update(Input),
    Remove(Input),
    Harnesses(Input),
    Configure(Input),
    Setup(Input),
    Exchange(Input),
    BoatConnect(Input),
    BoatDisconnect(Input),
    BoatStatus(Input),
    BoatAdd(Input),
    BoatDelete(Input),
    Wake(Input),
    Sleep(Input),
    Link(Input),
    LinkKey(Input),
    LinkAccept(Input),
    LinkOpen(Input),
    LinkRevoke(Input),
    Logs {
        name: String,
        #[command(flatten)]
        filters: Filters,
    },
    SeatStart(SeatRef),
    SeatStop(SeatRef),
    SeatRead {
        #[command(flatten)]
        seat: SeatRef,
        #[arg(long)]
        lines: Option<i64>,
    },
    VaultToken {
        name: String,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        mint: bool,
    },
    VaultTokenLocal,
}

/// How long an owner op may take: a send and a Boat machine made from
/// nothing take minutes; a wake or a key, a few.
fn bound(op: &str) -> Option<u64> {
    match op {
        "machine.send" | "machine.update" | "machine.boat-add" => Some(15 * 60_000),
        "machine.boat-connect"
        | "machine.boat-disconnect"
        | "machine.boat-delete"
        | "machine.wake"
        | "machine.sleep"
        | "machine.remove"
        | "machine.link"
        | "machine.link-open" => Some(5 * 60_000),
        _ => None,
    }
}

/// An owner op whose input is the JSON the owner wrote; the runtime decodes it.
fn owner(op: &str, input: &Input) -> Answer {
    let args: Value = input::load(&input.input)?;
    operator::call(op, &args, bound(op)).map(Into::into)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeatArgs<'a> {
    canvas: &'a str,
    seat_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<i64>,
}

impl SeatRef {
    fn args(&self, lines: Option<i64>) -> SeatArgs<'_> {
        SeatArgs {
            canvas: &self.canvas,
            seat_id: &self.seat,
            lines,
        }
    }
}

#[derive(Serialize)]
struct LogsArgs<'a> {
    name: &'a str,
    query: Query,
}

impl Run for Machine {
    fn run(self) -> ExitCode {
        let owned = |name: &str, op: &str, input: &Input| {
            envelope::print(&format!("machine {name}"), owner(op, input))
        };
        match self.command {
            Command::InstallLocal(i) => local("install-local", Some(&i.input)),
            Command::UninstallLocal(i) => local("uninstall-local", Some(&i.input)),
            Command::BoatKeyLocal => local("boat-key-local", None),
            Command::Add(i) => owned("add", "machine.add", &i),
            Command::List(i) => owned("list", "machine.list", &i),
            Command::Send(i) => owned("send", "machine.send", &i),
            Command::Status(i) => owned("status", "machine.status", &i),
            Command::Update(i) => owned("update", "machine.update", &i),
            Command::Remove(i) => owned("remove", "machine.remove", &i),
            Command::Harnesses(i) => owned("harnesses", "machine.harnesses", &i),
            Command::Configure(i) => owned("configure", "machine.configure", &i),
            Command::Setup(i) => owned("setup", "machine.setup", &i),
            Command::Exchange(i) => owned("exchange", "machine.exchange", &i),
            Command::BoatConnect(i) => owned("boat-connect", "machine.boat-connect", &i),
            Command::BoatDisconnect(i) => owned("boat-disconnect", "machine.boat-disconnect", &i),
            Command::BoatStatus(i) => owned("boat-status", "machine.boat-status", &i),
            Command::BoatAdd(i) => owned("boat-add", "machine.boat-add", &i),
            Command::BoatDelete(i) => owned("boat-delete", "machine.boat-delete", &i),
            Command::Wake(i) => owned("wake", "machine.wake", &i),
            Command::Sleep(i) => owned("sleep", "machine.sleep", &i),
            Command::Link(i) => owned("link", "machine.link", &i),
            Command::LinkKey(i) => owned("link-key", "machine.link-key", &i),
            Command::LinkAccept(i) => owned("link-accept", "machine.link-accept", &i),
            Command::LinkOpen(i) => owned("link-open", "machine.link-open", &i),
            Command::LinkRevoke(i) => owned("link-revoke", "machine.link-revoke", &i),
            Command::Logs { name, filters } => {
                let answer = filters
                    .lower()
                    .and_then(|query| {
                        operator::call("machine.logs", &LogsArgs { name: &name, query }, None)
                    })
                    .map(Into::into);
                envelope::print("machine logs", answer)
            }
            Command::SeatStart(seat) => envelope::print(
                "machine seat-start",
                operator::call("machine.seat-start", &seat.args(None), Some(120_000))
                    .map(Into::into),
            ),
            Command::SeatStop(seat) => envelope::print(
                "machine seat-stop",
                operator::call("machine.seat-stop", &seat.args(None), None).map(Into::into),
            ),
            Command::SeatRead { seat, lines } => envelope::print(
                "machine seat-read",
                operator::call("machine.seat-read", &seat.args(lines), None).map(Into::into),
            ),
            Command::VaultToken { name, vault, mint } => {
                envelope::print("machine vault-token", vault_token(&name, &vault, mint))
            }
            Command::VaultTokenLocal => {
                envelope::print("machine vault-token-local", vault_token_local())
            }
        }
    }
}

// --- the bundle's Node entry ---

/// The machine-local entry beside this binary: `<root>/bin/node` runs
/// `<root>/core/machine-local.cjs`, which owns the install lock and the files.
fn local(command: &str, input: Option<&str>) -> ExitCode {
    let entry = std::env::current_exe()
        .and_then(|exe| exe.canonicalize())
        .ok()
        .and_then(|exe| {
            let root = exe.parent()?.parent()?.to_path_buf();
            let paths: (PathBuf, PathBuf) =
                (root.join("bin/node"), root.join("core/machine-local.cjs"));
            (paths.0.is_file() && paths.1.is_file()).then_some(paths)
        });
    let Some((node, script)) = entry else {
        let failure = Failure::new(
            ErrorType::InternalError,
            format!(
                "machine {command} runs on a machine bundle's Node, and this junto has none beside it"
            ),
        );
        return envelope::refuse(Some(&format!("machine {command}")), &failure);
    };
    // exec replaces this process: the entry's envelope and exit code are the answer.
    let error = std::process::Command::new(node)
        .arg(script)
        .arg(command)
        .args(input)
        .exec();
    envelope::refuse(
        Some(&format!("machine {command}")),
        &Failure::new(ErrorType::InternalError, error.to_string()),
    )
}

// --- the vault ---

/// Longer than the mint's approval wait plus its placement.
const VAULT_MINT_CALL_MS: u64 = 10 * 60_000;
/// A stdin delivery is at most this many bytes.
const STDIN_MAX_BYTES: u64 = 4_096;

/// Fixed words: a token that fails to decode never shows in the failure.
fn not_placed(message: &str) -> Failure {
    Failure::new(ErrorType::VaultTokenNotPlaced, message)
}

fn vault_enabled() -> Result<()> {
    if features::VAULT {
        Ok(())
    } else {
        Err(not_placed("The vault is not in this build"))
    }
}

/// The whole of stdin, bounded.
fn read_stdin() -> Option<String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(STDIN_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > STDIN_MAX_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// VaultName: no `:`, `,`, `/` or control character, no space at either end.
fn vault_name(name: &str) -> bool {
    let inner = |c: char| !matches!(c, ':' | ',' | '/') && !c.is_control();
    let edge = |c: Option<char>| c.is_some_and(|c| inner(c) && !c.is_whitespace());
    (1..=128).contains(&name.chars().count())
        && name.chars().all(inner)
        && edge(name.chars().next())
        && edge(name.chars().last())
}

/// VaultTokenSecret: a 1Password service account token.
fn token_secret(token: &str) -> bool {
    token.len() <= 3072
        && token.strip_prefix("ops_").is_some_and(|body| {
            body.len() >= 20
                && body
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=_.-".contains(&b))
        })
}

/// VaultAccountName: `junto-<machine>-read` or `-write`.
fn account_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("junto-") else {
        return false;
    };
    let Some(machine) = rest
        .strip_suffix("-read")
        .or_else(|| rest.strip_suffix("-write"))
    else {
        return false;
    };
    let mut bytes = machine.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && machine.len() <= 64
        && bytes.all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

#[derive(Serialize)]
struct VaultTokenArgs<'a> {
    name: &'a str,
    vault: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mint: Option<bool>,
}

/// One machine's service-account token, read from stdin, or with `--mint`
/// minted under the operator's own 1Password session.
fn vault_token(name: &str, vault: &str, mint: bool) -> Answer {
    operator::require_owner()?;
    vault_enabled()?;
    if !vault_name(vault) {
        return Err(not_placed(
            "A vault name holds no : , / or control character",
        ));
    }
    let token = if mint {
        None
    } else {
        if std::io::stdin().is_terminal() {
            return Err(not_placed(
                "Pipe the token in on stdin, for example from op read or pbpaste; it is never typed here",
            ));
        }
        let text = read_stdin()
            .ok_or_else(|| not_placed("The vault token could not be read from stdin"))?;
        let token = text.trim();
        if !token_secret(token) {
            return Err(not_placed("That is not a 1Password service account token"));
        }
        Some(token.to_string())
    };
    if !(1..=64).contains(&name.chars().count()) {
        return Err(not_placed("The machine name is not one Junto knows"));
    }
    let args = VaultTokenArgs {
        name,
        vault,
        token,
        mint: mint.then_some(true),
    };
    // A mint may wait minutes on the operator's approval; the call outlives it.
    let bound = if mint { VAULT_MINT_CALL_MS } else { 2 * 60_000 };
    operator::call("machine.vault-token", &args, Some(bound)).map(Into::into)
}

/// VaultTokenDelivery: what the window's machine writes to this one's stdin.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Delivery {
    vault: String,
    permissions: Permissions,
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_name: Option<String>,
}

#[derive(Serialize, Deserialize)]
enum Permissions {
    #[serde(rename = "read_items")]
    Read,
    #[serde(rename = "read_items,write_items")]
    ReadWrite,
}

/// On the machine the token is for, over the window machine's SSH session:
/// the token from stdin to this machine's core, which writes it 0600.
fn vault_token_local() -> Answer {
    operator::require_owner()?;
    vault_enabled()?;
    let text =
        read_stdin().ok_or_else(|| not_placed("The vault token could not be read from stdin"))?;
    let delivery = serde_json::from_str::<Delivery>(&text)
        .ok()
        .filter(|d| {
            vault_name(&d.vault)
                && token_secret(&d.token)
                && d.account_name.as_deref().is_none_or(account_name)
        })
        .ok_or_else(|| not_placed("The vault token did not match its shape"))?;
    operator::call("machine.vault-receive", &delivery, None).map(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_vault_shapes_as_their_schemas() {
        assert!(vault_name("Junto fleet"));
        for bad in ["", " lead", "a:b", "a/b", "a,b", "tail "] {
            assert!(!vault_name(bad), "{bad}");
        }
        assert!(token_secret(&format!("ops_{}", "a".repeat(20))));
        assert!(!token_secret(&format!("ops_{}", "a".repeat(19))));
        assert!(account_name("junto-mini-read") && account_name("junto-book.2-write"));
        assert!(!account_name("junto--read") && !account_name("junto-mini-admin"));
    }
}
