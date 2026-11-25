//! The one scrub, as src/node/credentials/scrub.ts runs it over text Junto did
//! not prove clean (docs/security-doctrine.md, Failures and logs): escape
//! sequences and control characters, the values this launch holds, then the
//! credential shapes Junto does not know, and a path keeps its segments while a
//! long mixed run goes. A message is one line, at most 1 KiB, cut marked.
//!
//! The install flow hands another machine's words to the editing machine, so
//! every one of them passes through here first.

use std::collections::BTreeSet;

use regex::Regex;
use std::sync::OnceLock;

pub const REDACTED: &str = "[redacted]";
const CUT: &str = " [cut]";
pub const SCRUBBED_MESSAGE_LIMIT: usize = 1024;
/// Shorter environment values ("1", "true") would redact ordinary words.
const ENVIRONMENT_VALUE_FLOOR: usize = 6;

/// Names whose values may show (doctrine 9ba4 step 3); a closed list, never a
/// prefix but `LC_`.
const SHOWN_ENVIRONMENT: [&str; 16] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "TMPDIR",
    "PWD",
    "TERM",
    "COLORTERM",
    "LANG",
    "JUNTO_HOME",
    "JUNTO_SEAT",
    "JUNTO_NODE_REF",
    "JUNTO_SOCKET",
    "JUNTO_WORK_SOCKET",
    "JUNTO_CLI",
];

fn shown_name(name: &str) -> bool {
    SHOWN_ENVIRONMENT.contains(&name) || name.starts_with("LC_")
}

struct Shapes {
    escapes: Regex,
    controls: Regex,
    private_key: Regex,
    authorization: Regex,
    bearer: Regex,
    url_userinfo: Regex,
    named_value: Regex,
    token_shapes: Regex,
    boat_key: Regex,
    boat_link: Regex,
    uuid: Regex,
}

fn shapes() -> &'static Shapes {
    static SHAPES: OnceLock<Shapes> = OnceLock::new();
    SHAPES.get_or_init(|| Shapes {
        escapes: Regex::new(
            r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)|\x1b[\s\S]?|\u{009b}[0-?]*[ -/]*[@-~]",
        )
        .expect("the escape pattern"),
        controls: Regex::new(
            "[\u{0000}-\u{0008}\u{000b}-\u{001f}\u{007f}-\u{009f}\u{061c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]",
        )
        .expect("the control pattern"),
        private_key: Regex::new(
            r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)",
        )
        .expect("the private key pattern"),
        authorization: Regex::new(r"(?i)(authorization\s*:\s*)[^\n]*")
            .expect("the authorization pattern"),
        bearer: Regex::new(r#"(?i)(\bbearer\s+)[^\s"',;]+"#).expect("the bearer pattern"),
        url_userinfo: Regex::new(r"(?i)(\b[a-z][a-z0-9+.-]{0,31}://)[^/\s@]+@")
            .expect("the url userinfo pattern"),
        named_value: Regex::new(
            r#"(?i)([A-Za-z0-9_.-]{0,48}(?:token|secret|password|passwd|key|credential|auth|cookie|session)[A-Za-z0-9_.-]{0,48}(?:"|')?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s&#"',;]+)"#,
        )
        .expect("the named value pattern"),
        token_shapes: Regex::new(
            r"\b(?:sk-|ghp_|gho_|github_pat_|xox[abpr]-)[A-Za-z0-9_-]+|\bops_[A-Za-z0-9+/=_.-]+|\bAKIA[A-Z0-9]{12,}|\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*",
        )
        .expect("the token shapes pattern"),
        boat_key: Regex::new(r"\b(?:boat|box)_[A-Za-z0-9_-]{24,}").expect("the boat key pattern"),
        boat_link: Regex::new(r#"(?i)(\bhttps?://(?:[a-z0-9-]+\.)*boat\.dev/[^\s?#"']*)[?#][^\s"']*"#)
            .expect("the boat link pattern"),
        uuid: Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            .expect("the uuid pattern"),
    })
}

/// Step 2: escape sequences whole, then the controls and bidi formatting left,
/// with a carriage return ending a line.
fn strip_controls(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let shapes = shapes();
    let without_escapes = shapes.escapes.replace_all(&unified, "");
    shapes
        .controls
        .replace_all(&without_escapes, "")
        .into_owned()
}

/// Step 3: every occurrence of every known value, longest first so a value
/// that contains another is not left half visible. Values shorter than four
/// characters are not searched for.
fn redact_known(text: &str, known: &[String]) -> String {
    let mut values: Vec<&str> = known
        .iter()
        .map(String::as_str)
        .filter(|value| value.chars().count() >= 4)
        .collect::<BTreeSet<&str>>()
        .into_iter()
        .collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.chars().count()));
    let mut out = text.to_string();
    for value in values {
        if !out.contains(value) {
            continue;
        }
        out = out.replace(value, REDACTED);
        // The same value as a tool may echo it: without a trailing newline.
        let trimmed = value.trim();
        if trimmed.chars().count() >= 4 && trimmed != value && out.contains(trimmed) {
            out = out.replace(trimmed, REDACTED);
        }
    }
    out
}

/// The values this launch holds: the environment's, from six characters, minus
/// the names the doctrine allows to show.
pub fn environment_secret_values(
    environment: impl IntoIterator<Item = (String, String)>,
) -> Vec<String> {
    environment
        .into_iter()
        .filter(|(name, value)| {
            !shown_name(name) && value.chars().count() >= ENVIRONMENT_VALUE_FLOOR
        })
        .map(|(_, value)| value)
        .collect()
}

/// The credentials this process's environment holds, as one launch's set.
pub fn process_secret_values() -> Vec<String> {
    environment_secret_values(std::env::vars())
}

// Step 4: the long mixed runs, judged so paths survive in segments.

const PATH_BOUNDARY: [char; 10] = [' ', '\t', '\n', '\r', '"', '\'', '`', '(', '=', '\u{2018}'];

fn is_path_boundary(c: char) -> bool {
    PATH_BOUNDARY.contains(&c)
        || ((c as u32) > 127 && matches!(c, '\u{2019}' | '\u{201c}' | '\u{201d}'))
}

/// A token's start, walking back to a boundary in one pass.
fn token_start(chars: &[char], at: usize) -> usize {
    let mut start = 0usize;
    for (index, c) in chars.iter().enumerate().take(at) {
        if is_path_boundary(*c) {
            start = index + 1;
        }
    }
    start
}

fn mixed_run(run: &str) -> bool {
    let count = run.chars().count();
    count >= 32
        && run.chars().any(|c| c.is_ascii_alphabetic())
        && run.chars().any(|c| c.is_ascii_digit())
}

/// Junto's own ids, <kind>-<ULID>, are not secrets.
fn is_junto_id(candidate: &str) -> bool {
    let Some((kind, ulid)) = candidate.split_once('-') else {
        return false;
    };
    (2..=16).contains(&kind.chars().count())
        && kind.chars().all(|c| c.is_ascii_lowercase())
        && ulid.chars().count() == 26
        && ulid.chars().all(
            |c| matches!(c, '0'..='9' | 'A'..='H' | 'J' | 'K' | 'M' | 'N' | 'P'..='T' | 'V'..='Z'),
        )
}

/// A run with no Junto id inside it is redacted when it is long and mixed;
/// one split by ids judges each piece and keeps the ids.
fn judge_piece(piece: &str) -> String {
    if piece.is_empty() {
        return String::new();
    }
    // Split at every candidate id, judged by its own shape.
    let chars: Vec<char> = piece.chars().collect();
    let mut out = String::new();
    let mut plain_start = 0usize;
    let mut at = 0usize;
    while at < chars.len() {
        let mut matched: Option<usize> = None;
        if at == 0 || !chars[at - 1].is_ascii_alphanumeric() {
            for len in (2..=16).rev() {
                let end = at + len + 27;
                if end > chars.len()
                    || !chars[at + len].eq(&'-')
                    || chars.get(end).is_some_and(|c| c.is_ascii_alphanumeric())
                {
                    continue;
                }
                let candidate: String = chars[at..end].iter().collect();
                if is_junto_id(&candidate) {
                    matched = Some(len + 27);
                    break;
                }
            }
        }
        match matched {
            Some(len) => {
                let plain: String = chars[plain_start..at].iter().collect();
                out.push_str(&judge_plain(&plain));
                let id: String = chars[at..at + len].iter().collect();
                out.push_str(&id);
                at += len;
                plain_start = at;
            }
            None => at += 1,
        }
    }
    let plain: String = chars[plain_start..].iter().collect();
    out.push_str(&judge_plain(&plain));
    out
}

fn judge_plain(run: &str) -> String {
    if mixed_run(run) {
        REDACTED.to_string()
    } else {
        run.to_string()
    }
}

/// A Junto build directory, <64 hex>-<target>: the public bundle hash.
fn is_build_segment(segment: &str) -> bool {
    ["-darwin-arm64", "-linux-x64"]
        .iter()
        .find_map(|suffix| segment.strip_suffix(suffix))
        .is_some_and(|hash| {
            hash.chars().count() == 64
                && hash
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        })
}

fn judge_segment(segment: &str) -> String {
    if is_build_segment(segment) {
        segment.to_string()
    } else {
        judge_piece(segment)
    }
}

/// A run that lies in a path keeps its segments; one that does not is judged
/// whole.
fn judge_run(chars: &[char], run: &str, offset: usize) -> String {
    let start = token_start(chars, offset);
    let token: String = chars[start..].iter().collect();
    // A run is a path when the token holding it starts with "/", "~/", "./" or
    // a file URL's path; only then may its segments be judged one by one.
    let path = token.starts_with('/') || token.starts_with("~/") || token.starts_with("./");
    if !path {
        return judge_piece(run);
    }
    run.split('/')
        .map(judge_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn long_runs(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        let c = chars[index];
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '_' | '-') {
            let start = index;
            while index < chars.len()
                && (chars[index].is_ascii_alphanumeric()
                    || matches!(chars[index], '+' | '/' | '_' | '-'))
            {
                index += 1;
            }
            // The pattern allows up to two trailing "=".
            let mut end = index;
            while end < chars.len() && end - index < 2 && chars[end] == '=' {
                end += 1;
            }
            let run: String = chars[start..end].iter().collect();
            if run.chars().count() >= 32 {
                let judged = judge_run(&chars, &run, start);
                out.push_str(&judged);
            } else {
                out.push_str(&run);
            }
            index = end;
            continue;
        }
        out.push(c);
        index += 1;
    }
    out
}

fn newline_runs() -> &'static Regex {
    static RUNS: OnceLock<Regex> = OnceLock::new();
    RUNS.get_or_init(|| Regex::new(r"\s*\n\s*").expect("the newline runs pattern"))
}

fn replace_shapes(text: &str, shapes: &Shapes) -> String {
    let mut out = shapes.private_key.replace_all(text, REDACTED).into_owned();
    out = shapes
        .authorization
        .replace_all(&out, format!("${{1}}{REDACTED}").as_str())
        .into_owned();
    out = shapes
        .bearer
        .replace_all(&out, format!("${{1}}{REDACTED}").as_str())
        .into_owned();
    out = shapes
        .url_userinfo
        .replace_all(&out, format!("${{1}}{REDACTED}@").as_str())
        .into_owned();
    out = shapes
        .named_value
        .replace_all(&out, format!("${{1}}{REDACTED}").as_str())
        .into_owned();
    out = shapes.token_shapes.replace_all(&out, REDACTED).into_owned();
    out = shapes.boat_key.replace_all(&out, REDACTED).into_owned();
    out = shapes
        .boat_link
        .replace_all(&out, format!("${{1}}?{REDACTED}").as_str())
        .into_owned();
    // A UUID is redacted whatever its digits: a credential id, never a path.
    let mut with_uuid = String::with_capacity(out.len());
    let mut last = 0usize;
    for found in shapes.uuid.find_iter(&out) {
        let (start, end) = (found.start(), found.end());
        let before = out[..start].chars().next_back();
        let after = out[end..].chars().next();
        let inside_word = before.is_some_and(|c| c.is_ascii_alphanumeric())
            || after.is_some_and(|c| c.is_ascii_alphanumeric());
        with_uuid.push_str(&out[last..start]);
        if inside_word {
            with_uuid.push_str(found.as_str());
        } else {
            with_uuid.push_str(REDACTED);
        }
        last = end;
    }
    with_uuid.push_str(&out[last..]);
    long_runs(&with_uuid)
}

/// Steps 2 to 4 over text Junto did not prove clean.
pub fn scrub_text_known(text: &str, known: &[String]) -> String {
    let stripped = strip_controls(text);
    let redacted = redact_known(&stripped, known);
    replace_shapes(&redacted, shapes())
}

/// The scrub with this process's own secrets, as a CLI's messages take it.
pub fn scrub_text(text: &str) -> String {
    scrub_text_known(text, &process_secret_values())
}

/// One cause-chain or log message: scrubbed, one line, at most 1 KiB, cut marked.
pub fn scrub_message(text: &str) -> String {
    scrub_message_known(text, &process_secret_values())
}

pub fn scrub_message_known(text: &str, known: &[String]) -> String {
    let scrubbed = scrub_text_known(text, known);
    let joined = newline_runs().replace_all(&scrubbed, " ");
    let one_line = joined.replace('\t', " ").trim().to_string();
    let characters: Vec<char> = one_line.chars().collect();
    if characters.len() <= SCRUBBED_MESSAGE_LIMIT {
        return one_line;
    }
    let keep: String = characters[..SCRUBBED_MESSAGE_LIMIT - CUT.len()]
        .iter()
        .collect();
    format!("{keep}{CUT}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn step_two_removes_escapes_controls_and_bidi_and_a_carriage_return_ends_a_line() {
        let text = scrub_text_known(
            "a\u{1b}[31mred\u{1b}[0m\u{1b}]0;TITLE\u{7}b\0c\u{7f}d\u{85}e\u{202e}f\u{2067}g\rnext\tTab",
            &none(),
        );
        assert_eq!(text, "aredbcdefg\nnext\tTab");
        assert!(!text.contains("TITLE"));
    }

    #[test]
    fn step_three_redacts_a_secret_from_four_characters_and_a_short_environment_value_not_at_all() {
        let known = vec!["s3cr".to_string(), "abcdef1".to_string()];
        let text = scrub_text_known("s3cr abcdef1 wxyz5", &known);
        assert_eq!(text, "[redacted] [redacted] wxyz5");
        let values = environment_secret_values([
            ("SHORT".to_string(), "wxyz5".to_string()),
            ("GH_TOKEN_VALUE".to_string(), "abcdef1".to_string()),
        ]);
        assert_eq!(values, vec!["abcdef1".to_string()]);
    }

    #[test]
    fn step_four_redacts_the_shapes_junto_does_not_know() {
        let seeded = [
            "Authorization: Basic dXNlcjpwYXNz",
            "curl -H 'Bearer abc.def-ghi'",
            "https://user:hunter2@example.com/path",
            "JUNTO_WORK_TOKEN=plainvalue",
            "session: cookievalue",
            "aws wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAkeybody\n-----END OPENSSH PRIVATE KEY-----",
            "sk-proj1234 ghp_abc123 AKIAABCDEFGHIJKLMNOP ops_abc",
            "digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "boat_abcdefghijklmnopqrstuvwxyz",
            "key 01a1202e-880e-7391-9903-bb0931c63820",
        ]
        .join("\n");
        let text = scrub_text_known(&seeded, &none());
        for secret in [
            "dXNlcjpwYXNz",
            "abc.def-ghi",
            "hunter2",
            "plainvalue",
            "cookievalue",
            "K7MDENG",
            "AAAAkeybody",
            "sk-proj1234",
            "ghp_abc123",
            "AKIAABCDEFGHIJKLMNOP",
            "9f86d081884c7d659a2f",
            "boat_abcdefghijklmnopqrstuvwxyz",
            "01a1202e-880e-7391-9903-bb0931c63820",
        ] {
            assert!(!text.contains(secret), "{secret} survived: {text}");
        }
        assert!(
            text.contains("https://[redacted]@example.com/path"),
            "{text}"
        );
    }

    #[test]
    fn paths_keep_their_segments_and_plain_words_survive() {
        for path in [
            "/Users/someone/Projects/junto/node_modules/node-pty/build/Release/pty.node",
            "open ~/x/node_modules/node-pty/build/Release/pty.node",
            "/Users/someone/.junto/machine/builds/2e0e0e5d2a5f8f9c0d5a1c0d9a0b8f7e6d5c4b3a291807162534435261708a9a-linux-x64/bin/junto",
        ] {
            assert_eq!(scrub_text_known(path, &none()), path);
        }
        assert_eq!(
            scrub_text_known(
                "TMPDIR=/var/folders/f5/yx3b1gkj5d7h9kq2m4n6p8r0t2v4x6z8/T/junto",
                &none()
            ),
            "TMPDIR=/var/folders/f5/[redacted]/T/junto"
        );
    }

    #[test]
    fn junto_ids_survive_and_a_mixed_tail_does_not() {
        assert_eq!(
            scrub_text_known(
                "seat agent-01M4G59ER01QPV3WBTEK3Z84TP in region-01M4FA8TRP5WCTVC26GVKPC5C2",
                &none()
            ),
            "seat agent-01M4G59ER01QPV3WBTEK3Z84TP in region-01M4FA8TRP5WCTVC26GVKPC5C2"
        );
        assert_eq!(
            scrub_text_known(
                "agent-01M4G59ER01QPV3WBTEK3Z84TPx9f86d081884c7d659a2feaa0c55ad015",
                &none()
            ),
            "[redacted]"
        );
    }

    #[test]
    fn a_message_is_one_line_bounded_and_cut_marked() {
        assert_eq!(scrub_message_known("a\n\n b\tc  ", &none()), "a b c");
        let long = "word ".repeat(400);
        let message = scrub_message_known(&long, &none());
        assert_eq!(message.chars().count(), SCRUBBED_MESSAGE_LIMIT);
        assert!(message.ends_with(CUT));
    }

    #[test]
    fn the_environment_keeps_the_names_the_doctrine_shows() {
        let values = environment_secret_values([
            ("JUNTO_HOME".to_string(), "/Users/someone".to_string()),
            ("LC_ALL".to_string(), "en_US.UTF-8".to_string()),
            ("SHORT".to_string(), "wxyz5".to_string()),
            ("GH_TOKEN_VALUE".to_string(), "abcdef1".to_string()),
        ]);
        assert_eq!(values, vec!["abcdef1".to_string()]);
    }
}
