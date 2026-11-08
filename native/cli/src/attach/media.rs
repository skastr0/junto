//! What a file is, judged by its bytes (src/shared/preview-bytes.ts): the
//! media type an attachment is recorded as, and the name it is shown by.

/// ATTACHMENT_HEAD_BYTES: how much of a file's start is looked at.
pub const HEAD_BYTES: usize = 64 * 1024;

/// ATTACHMENT_OTHER_MEDIA_TYPE: a file a preview shows by its name only.
const OTHER: &str = "application/octet-stream";

/// previewExtension: the last segment's extension, lowercased; none for a dotfile.
fn extension(name: &str) -> String {
    let name = name.rsplit('/').next().unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn raster(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

/// MP4 and QuickTime share one box layout, told apart by the brand; an
/// audio-only brand is no video. The extension tells the Matroska flavours apart.
fn video(bytes: &[u8], name: &str) -> Option<&'static str> {
    match bytes {
        [_, _, _, _, b'f', b't', b'y', b'p', brand @ ..] if brand.len() >= 4 => match &brand[..4] {
            [b'M', b'4', b'A' | b'B', _] => None,
            b"qt  " => Some("video/quicktime"),
            _ => Some("video/mp4"),
        },
        [0x1a, 0x45, 0xdf, 0xa3, ..] if extension(name) == "mkv" => Some("video/x-matroska"),
        [0x1a, 0x45, 0xdf, 0xa3, ..] => Some("video/webm"),
        _ => None,
    }
}

/// isTextHead: no NUL and valid UTF-8, a character cut off at the end forgiven.
pub fn is_text_head(head: &[u8]) -> bool {
    !head.contains(&0)
        && match std::str::from_utf8(head) {
            Ok(_) => true,
            Err(error) => error.error_len().is_none(),
        }
}

/// attachmentName: the last segment only, with no control character, line or
/// paragraph separator, or bidi control that could forge a line or reverse a path.
pub fn name(raw: &str) -> String {
    let last = raw
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let forged = |c: char| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
    let clean: String = last.chars().filter(|c| !forged(*c)).collect();
    clean.trim().chars().take(255).collect()
}

/// attachmentMediaType: a raster or a video by its bytes, a drawing by its svg
/// name, text by its bytes (a known name gives a closer type), else a file.
pub fn media_type(name: &str, head: &[u8]) -> &'static str {
    if let Some(kind) = raster(head).or_else(|| video(head, name)) {
        return kind;
    }
    let extension = extension(name);
    if extension == "svg" {
        return "image/svg+xml";
    }
    if !is_text_head(head) {
        return OTHER;
    }
    match extension.as_str() {
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "diff" | "patch" => "text/x-diff",
        "txt" | "log" => "text/plain",
        _ if head.is_empty() => OTHER,
        _ => "text/plain",
    }
}

/// The head of text held here: its first HEAD_BYTES UTF-16 units, as UTF-8
/// (`Buffer.from(text.slice(0, ATTACHMENT_HEAD_BYTES))`).
pub fn text_head(text: &str) -> &str {
    let mut units = 0;
    let end = text
        .char_indices()
        .find(|(_, c)| {
            units += c.len_utf16();
            units > HEAD_BYTES
        })
        .map_or(text.len(), |(at, _)| at);
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judges_by_bytes_then_name() {
        assert_eq!(media_type("a.txt", b"\x89PNG\r\n\x1a\nrest"), "image/png");
        assert_eq!(media_type("a", b"\0\0\0\x18ftypqt  "), "video/quicktime");
        assert_eq!(media_type("a", b"\0\0\0\x18ftypM4A "), OTHER);
        assert_eq!(media_type("a.mkv", b"\x1a\x45\xdf\xa3"), "video/x-matroska");
        assert_eq!(media_type("a.svg", b"\0"), "image/svg+xml");
        assert_eq!(media_type("a.diff", b"--- a"), "text/x-diff");
        assert_eq!(media_type("a.rs", b"fn main"), "text/plain");
        assert_eq!(media_type("a.rs", b""), OTHER);
        assert_eq!(media_type("a.md", b"\xe2\x82"), "text/markdown");
        assert_eq!(media_type("a.md", b"\xff"), OTHER);
    }

    #[test]
    fn names_the_last_segment_clean() {
        assert_eq!(name("/a/b\\c.txt/"), "c.txt");
        assert_eq!(name("ev\u{202e}il\n.txt"), "evil.txt");
        assert_eq!(name("///"), "");
        assert_eq!(extension("/.bashrc"), "");
    }
}
