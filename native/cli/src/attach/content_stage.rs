//! Put one file of this seat's into the content store, and answer the
//! reference to name it by (src/cli/core/content-stage.ts).
//!
//! The bytes go up a piece at a time, each piece its own `content.stage`
//! call, so a file of any size crosses the socket without being whole in
//! memory. The path stays on this side: only bytes cross. The digest is taken
//! as the pieces go and sent with the last one, so main refuses a file that
//! did not arrive as it left.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{ErrorType, Failure, Result};
use crate::ops;
use crate::wire::{self, Timeout};

/// CONTENT_STAGE_PIECE_BYTES: the most raw bytes one piece carries.
const PIECE_BYTES: usize = 4 * 1024 * 1024;

/// What the file is, as the upload closes: its type and the name it shows.
#[derive(Debug, Clone, Copy)]
pub struct Label<'a> {
    pub media_type: &'a str,
    pub display_name: Option<&'a str>,
}

/// ContentRef: the file as the content store holds it, keys in the schema's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedRef {
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// ContentIdentity: a staged file as a record that claims it names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub sha256: String,
    pub byte_length: u64,
}

impl StagedRef {
    pub fn identity(&self) -> Identity {
        Identity { sha256: self.sha256.clone(), byte_length: self.byte_length }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Done<'a> {
    media_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<&'a str>,
    expected: Expected,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    sha256: String,
    byte_length: u64,
}

/// ContentStageArgs: one piece, and on the last one what closes the upload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageArgs<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    stage_id: Option<String>,
    bytes_base64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    done: Option<Done<'a>>,
}

ops! { StageArgs<'_> => "content.stage" }

/// ContentStageResult: the upload still open, or the file as the store holds it.
#[derive(Deserialize)]
#[serde(untagged)]
enum Staged {
    Closed {
        #[serde(rename = "ref")]
        reference: StagedRef,
    },
    Open {
        #[serde(rename = "stageId")]
        stage_id: String,
    },
}

fn protocol(message: &str) -> Failure {
    Failure::new(ErrorType::ProtocolError, message)
}

fn unreadable(path: &Path) -> Failure {
    Failure::input("the file could not be read", path.display().to_string())
        .and("hint", "check that the path names a file this process may read")
}

/// ContentStageId: `stg_` and 32 lowercase hex digits.
fn is_stage_id(id: &str) -> bool {
    id.strip_prefix("stg_")
        .is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// Sends pieces until one comes back short of a full piece, which closes the
/// upload. `next` answers the next piece each time it is called.
fn stage_pieces(mut next: impl FnMut() -> Result<Vec<u8>>, label: Label, timeout: Timeout) -> Result<StagedRef> {
    let mut digest = Sha256::new();
    let mut byte_length = 0u64;
    let mut stage_id = None;
    // One piece is held back so the last one closes the upload itself.
    let mut held = next()?;
    loop {
        digest.update(&held);
        byte_length += held.len() as u64;
        let following = if held.len() < PIECE_BYTES { Vec::new() } else { next()? };
        let last = following.is_empty();
        let args = StageArgs {
            stage_id: stage_id.take(),
            bytes_base64: STANDARD.encode(&held),
            done: last.then(|| Done {
                media_type: label.media_type,
                display_name: label.display_name,
                expected: Expected { sha256: hex(&digest.clone().finalize()), byte_length },
            }),
        };
        let answer = wire::call(&args, timeout)?;
        match serde_json::from_str(answer.get()) {
            Ok(Staged::Closed { reference }) => return Ok(reference),
            Ok(Staged::Open { .. }) if last => return Err(protocol("content.stage did not close the upload")),
            Ok(Staged::Open { stage_id: id }) if is_stage_id(&id) => stage_id = Some(id),
            _ => return Err(protocol("content.stage answered in a form this CLI does not know")),
        }
        held = following;
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// stageFile: a file on disk, read a piece at a time. The one way a native
/// command puts a file of its seat's into the content store.
pub fn file(path: &Path, label: Label, timeout: Timeout) -> Result<StagedRef> {
    let mut file = File::open(path).map_err(|_| unreadable(path))?;
    let next = || {
        let mut piece = Vec::with_capacity(PIECE_BYTES);
        // A read may come back short before the end of the file: read to the piece's end.
        file.by_ref()
            .take(PIECE_BYTES as u64)
            .read_to_end(&mut piece)
            .map(|_| piece)
            .map_err(|_| unreadable(path))
    };
    stage_pieces(next, label, timeout)
}

/// stageBytes: bytes held here, such as text an agent typed, sent in pieces
/// like a file; no file is written to send them.
pub fn bytes(all: &[u8], label: Label, timeout: Timeout) -> Result<StagedRef> {
    let mut pieces = all.chunks(PIECE_BYTES);
    stage_pieces(|| Ok(pieces.next().map(<[u8]>::to_vec).unwrap_or_default()), label, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_answer_shapes() {
        let closed: Staged = serde_json::from_str(r#"{"ref":{"sha256":"ab","byteLength":3,"mediaType":"x","more":1}}"#).unwrap();
        assert!(matches!(closed, Staged::Closed { reference } if reference.byte_length == 3 && reference.display_name.is_none()));
        let open: Staged = serde_json::from_str(r#"{"stageId":"stg_0123456789abcdef0123456789abcdef","byteLength":4}"#).unwrap();
        assert!(matches!(open, Staged::Open { stage_id } if is_stage_id(&stage_id)));
        assert!(!is_stage_id("stg_0123"));
    }
}
