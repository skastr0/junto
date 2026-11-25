//! The built binary's `junto link`: the byte relay the native CLI now owns.
//! These are the behaviours `tests/machine-link.test.ts` and the relay half
//! of `tests/link-opener.test.ts` held for the TypeScript CLI.

use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;

/// A throwaway Junto home with the core socket directory ready.
struct Home(PathBuf);

impl Home {
    fn new() -> Home {
        let home = std::env::temp_dir().join(format!("junto-link-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(home.join(".junto/core")).unwrap();
        Home(home)
    }

    fn socket(&self) -> PathBuf {
        self.0.join(".junto/core/control.sock")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_junto"));
        command
            .args(args)
            .env("HOME", &self.0)
            .env_remove("JUNTO_HOME")
            .env_remove("JUNTO_WORK_HOME")
            .env_remove("JUNTO_WORK_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

#[test]
fn relays_both_directions_verbatim_and_keeps_the_final_bytes() {
    let home = Home::new();
    let listener = UnixListener::bind(home.socket()).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.write_all(b"hello\n").unwrap();
        let mut echoed = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            echoed.extend_from_slice(&buffer[..read]);
            stream.write_all(&buffer[..read]).unwrap();
        }
        stream.write_all(b"finished\n").unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        echoed
    });

    let mut child = home.command(&["link"]).spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&[0x00, 0xff, 0x0a])
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let echoed = server.join().unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(echoed, [0x00, 0xff, 0x0a]);
    assert_eq!(output.stdout, b"hello\n\x00\xff\x0afinished\n");
}

#[test]
fn writes_the_opener_line_before_any_far_end_byte() {
    let home = Home::new();
    let listener = UnixListener::bind(home.socket()).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut received = Vec::new();
        stream.read_to_end(&mut received).unwrap();
        received
    });

    let mut child = home
        .command(&["link", "--opener", "mini-install"])
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"far end bytes\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let received = server.join().unwrap();

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert_eq!(
        received,
        b"{\"type\":\"opener\",\"installationId\":\"mini-install\"}\nfar end bytes\n"
    );
}

#[test]
fn a_missing_core_prints_its_words_and_no_protocol_bytes() {
    let home = Home::new();
    let output = home.command(&["link"]).output().unwrap();

    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty(), "stdout: {:?}", output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("junto link: the Junto core is not running"),
        "stderr: {stderr:?}"
    );
    assert!(
        !stderr.contains("starting the Junto core"),
        "stderr: {stderr:?}"
    );
}
