//! `coforge-installer`: feasibility spike for a separately released native installer.
//!
//! Commands:
//!   coforge-installer --version
//!   coforge-installer status --json
//!   coforge-installer fetch --url <https url> --sha256 <hex> --out <path>
//!                           [--expanded-sha256 <hex>] [--max-bytes <n>]
//!
//! Machine output is one JSON object on stdout; the exit status is 0 on success, 1 on a
//! failed operation, and 2 on a usage error.

mod fetch;

use std::path::PathBuf;
use std::process::ExitCode;

use lexopt::ValueExt;
use serde::Serialize;

const PROTOCOL: &str = "coforge-installer/v0";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The release-target vocabulary CoForge already uses (`darwin-arm64`, `linux-x64`, ...).
const OS: &str = match std::env::consts::OS.as_bytes() {
    b"macos" => "darwin",
    _ => std::env::consts::OS,
};
const ARCH: &str = match std::env::consts::ARCH.as_bytes() {
    b"aarch64" => "arm64",
    b"x86_64" => "x64",
    _ => std::env::consts::ARCH,
};

enum Command {
    Version,
    Status,
    Fetch(fetch::FetchRequest),
}

#[derive(Serialize)]
struct Status {
    protocol: &'static str,
    os: &'static str,
    arch: &'static str,
}

#[derive(Serialize)]
struct Failure<'a> {
    protocol: &'static str,
    ok: bool,
    code: &'a str,
    message: &'a str,
}

#[derive(Serialize)]
struct Success<T: Serialize> {
    protocol: &'static str,
    ok: bool,
    #[serde(flatten)]
    result: T,
}

fn main() -> ExitCode {
    let command = match parse(std::env::args_os().skip(1)) {
        Ok(command) => command,
        Err(message) => {
            print_json(&Failure {
                protocol: PROTOCOL,
                ok: false,
                code: "USAGE",
                message: &message,
            });
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Version => {
            println!("coforge-installer {VERSION}");
            ExitCode::SUCCESS
        }
        Command::Status => {
            print_json(&Status {
                protocol: PROTOCOL,
                os: OS,
                arch: ARCH,
            });
            ExitCode::SUCCESS
        }
        Command::Fetch(request) => match fetch::fetch(&fetch::https_agent(), &request) {
            Ok(receipt) => {
                print_json(&Success {
                    protocol: PROTOCOL,
                    ok: true,
                    result: receipt,
                });
                ExitCode::SUCCESS
            }
            Err(error) => {
                print_json(&Failure {
                    protocol: PROTOCOL,
                    ok: false,
                    code: error.code.as_str(),
                    message: &error.message,
                });
                ExitCode::from(1)
            }
        },
    }
}

fn print_json(value: &impl Serialize) {
    // Serializing these plain structs cannot fail.
    println!("{}", serde_json::to_string(value).unwrap_or_default());
}

fn parse(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut parser = lexopt::Parser::from_args(args);
    let subcommand = match parser.next().map_err(|error| error.to_string())? {
        Some(Long("version")) => return finish(parser, Command::Version),
        Some(Value(value)) => value.string().map_err(|error| error.to_string())?,
        Some(other) => return Err(other.unexpected().to_string()),
        None => return Err("expected a command: fetch, status, or --version".into()),
    };

    match subcommand.as_str() {
        "status" => {
            let mut json = false;
            while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
                match arg {
                    Long("json") => json = true,
                    other => return Err(other.unexpected().to_string()),
                }
            }
            if !json {
                return Err("status supports only --json output".into());
            }
            Ok(Command::Status)
        }
        "fetch" => parse_fetch(parser).map(Command::Fetch),
        other => Err(format!("unknown command: {other}")),
    }
}

fn finish(mut parser: lexopt::Parser, command: Command) -> Result<Command, String> {
    match parser.next().map_err(|error| error.to_string())? {
        None => Ok(command),
        Some(other) => Err(other.unexpected().to_string()),
    }
}

fn parse_fetch(mut parser: lexopt::Parser) -> Result<fetch::FetchRequest, String> {
    use lexopt::prelude::*;

    let mut url = None;
    let mut sha256 = None;
    let mut expanded_sha256 = None;
    let mut out = None;
    let mut max_bytes = fetch::DEFAULT_MAX_BYTES;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("url") => url = Some(value(&mut parser)?),
            Long("sha256") => sha256 = Some(checksum("--sha256", value(&mut parser)?)?),
            Long("expanded-sha256") => {
                expanded_sha256 = Some(checksum("--expanded-sha256", value(&mut parser)?)?)
            }
            Long("out") => out = Some(PathBuf::from(value(&mut parser)?)),
            Long("max-bytes") => {
                max_bytes = value(&mut parser)?
                    .parse()
                    .map_err(|_| "--max-bytes takes a byte count".to_string())?
            }
            other => return Err(other.unexpected().to_string()),
        }
    }
    let url = url.ok_or("fetch requires --url")?;
    if !url.starts_with("https://") {
        return Err("--url must be an https:// URL".into());
    }
    Ok(fetch::FetchRequest {
        url,
        sha256: sha256.ok_or("fetch requires --sha256")?,
        expanded_sha256,
        out: out.ok_or("fetch requires --out")?,
        max_bytes,
    })
}

fn value(parser: &mut lexopt::Parser) -> Result<String, String> {
    parser
        .value()
        .and_then(|value| value.string())
        .map_err(|error| error.to_string())
}

/// Accepts exactly 64 hex digits and normalizes them to lowercase.
fn checksum(flag: &str, value: String) -> Result<String, String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(format!("{flag} takes a 64-digit hex SHA-256"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<std::ffi::OsString> {
        list.iter().map(Into::into).collect()
    }

    #[test]
    fn fetch_rejects_a_plain_http_url() {
        let error = parse(args(&[
            "fetch",
            "--url",
            "http://example.com/a.gz",
            "--sha256",
            &"a".repeat(64),
            "--out",
            "x",
        ]))
        .err()
        .expect("plain http must be refused");
        assert!(error.contains("https://"), "{error}");
    }

    #[test]
    fn fetch_rejects_a_malformed_checksum() {
        let error = parse(args(&[
            "fetch",
            "--url",
            "https://example.com/a.gz",
            "--sha256",
            "abc",
            "--out",
            "x",
        ]))
        .err()
        .expect("a short checksum must be refused");
        assert!(error.contains("64-digit"), "{error}");
    }

    #[test]
    fn status_reports_the_release_target_vocabulary() {
        assert!(matches!(OS, "darwin" | "linux" | "windows"), "{OS}");
        assert!(matches!(ARCH, "arm64" | "x64"), "{ARCH}");
    }
}
