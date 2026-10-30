//! admitLinkUrl (src/shared/wire/agent-signals.ts): the web address a link
//! attachment may carry, read as a browser reads it (WHATWG URL), or why not.

use url::Url;

/// The address normalized, or why it cannot be attached.
pub fn admit(raw: &str) -> Result<String, &'static str> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "not a web address")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http and https addresses can be attached");
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("the address has no host");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("the address carries a name or a password; remove them");
    }
    Ok(parsed.into())
}

#[cfg(test)]
mod tests {
    use super::admit;

    #[test]
    fn admits_as_a_browser_reads() {
        assert_eq!(admit(" HTTPS://Host.example/a/../run.mp4 "), Ok("https://host.example/run.mp4".into()));
        assert_eq!(admit("https://host"), Ok("https://host/".into()));
        assert_eq!(admit("ftp://host/x"), Err("only http and https addresses can be attached"));
        assert_eq!(admit("https://u:p@host/"), Err("the address carries a name or a password; remove them"));
        assert_eq!(admit("nope"), Err("not a web address"));
    }
}
