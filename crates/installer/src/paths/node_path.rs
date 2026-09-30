//! `path.posix.join` and `path.win32.join` from Node's `lib/path.js`
//! (https://github.com/nodejs/node/blob/main/lib/path.js), with the `normalize` and
//! `normalizeString` they call, and nothing else of that module.
//!
//! The Computer builds every installation directory with those two functions
//! (packages/computer/src/paths.ts) and it runs on Bun, so this is a port of what Bun's
//! `node:path` does, checked against it: the golden cases in
//! crates/installer/contract/paths.json are Bun's output. Bun 1.4.2 matches Node v22.12.0's
//! `win32.normalize`. It predates three later additions in Node's `main`, which this port
//! therefore leaves out: the reserved device names (`COM1:`, `NUL:`), the `.\` prefix that stops
//! a relative path with a colon from reading as a drive (CVE-2024-36139), and the `\\.\` and
//! `\\?\` device roots. None of them is a plausible home directory.
//!
//! JavaScript strings are UTF-16 and Node measures and slices them in code units, so the port
//! works on `u16` too: a length or an index means the same thing here as it does there. Every
//! cut is at an ASCII separator or drive letter, so the result is always valid UTF-16.

const DOT: u16 = b'.' as u16;
const COLON: u16 = b':' as u16;
const FORWARD_SLASH: u16 = b'/' as u16;
const BACKSLASH: u16 = b'\\' as u16;

/// `path.posix.join(...parts)`.
pub fn posix_join(parts: &[&str]) -> String {
    let parts = non_empty(parts);
    if parts.is_empty() {
        return ".".to_owned();
    }
    into_string(posix_normalize(&parts.join(&FORWARD_SLASH)))
}

/// `path.win32.join(...parts)`.
pub fn win32_join(parts: &[&str]) -> String {
    let parts = non_empty(parts);
    let Some(first_part) = parts.first() else {
        return ".".to_owned();
    };
    let mut joined = parts.join(&BACKSLASH);

    // `normalize` reads a leading `\\` as the start of a UNC root, so a join whose first part
    // starts with two or more separators must not begin with them, unless that part is clearly a
    // UNC path: exactly two separators followed by something that is not one.
    let mut needs_replace = true;
    let mut slash_count = 0;
    if is_win32_separator(first_part[0]) {
        slash_count += 1;
        if first_part.len() > 1 && is_win32_separator(first_part[1]) {
            slash_count += 1;
            if first_part.len() > 2 {
                if is_win32_separator(first_part[2]) {
                    slash_count += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        while slash_count < joined.len() && is_win32_separator(joined[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            joined.splice(..slash_count, [BACKSLASH]);
        }
    }
    into_string(win32_normalize(&joined))
}

/// The parts that are not empty, as UTF-16: `join` ignores an empty argument, so the first
/// part is the first one that has any text.
fn non_empty(parts: &[&str]) -> Vec<Vec<u16>> {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| units(part))
        .collect()
}

fn into_string(units: Vec<u16>) -> String {
    String::from_utf16(&units).expect("every cut is at an ASCII code unit, so no pair is split")
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn is_posix_separator(code: u16) -> bool {
    code == FORWARD_SLASH
}

fn is_win32_separator(code: u16) -> bool {
    code == FORWARD_SLASH || code == BACKSLASH
}

fn is_windows_device_root(code: u16) -> bool {
    u8::try_from(code).is_ok_and(|byte| byte.is_ascii_alphabetic())
}

/// `path.posix.normalize`.
fn posix_normalize(path: &[u16]) -> Vec<u16> {
    if path.is_empty() {
        return units(".");
    }
    let is_absolute = path[0] == FORWARD_SLASH;
    let trailing_separator = path[path.len() - 1] == FORWARD_SLASH;

    let mut normalized = normalize_string(path, !is_absolute, FORWARD_SLASH, is_posix_separator);
    if normalized.is_empty() {
        return units(match (is_absolute, trailing_separator) {
            (true, _) => "/",
            (false, true) => "./",
            (false, false) => ".",
        });
    }
    if trailing_separator {
        normalized.push(FORWARD_SLASH);
    }
    if is_absolute {
        normalized.insert(0, FORWARD_SLASH);
    }
    normalized
}

/// `path.win32.normalize`, as Node v22.12.0 and Bun have it (see the module comment).
fn win32_normalize(path: &[u16]) -> Vec<u16> {
    let len = path.len();
    if len == 0 {
        return units(".");
    }
    let code = path[0];
    if len == 1 {
        return if code == FORWARD_SLASH {
            vec![BACKSLASH]
        } else {
            path.to_vec()
        };
    }

    let mut root_end = 0;
    let mut device: Option<Vec<u16>> = None;
    let mut is_absolute = false;

    if is_win32_separator(code) {
        // Starting with a separator makes it absolute, and possibly the start of a UNC root.
        is_absolute = true;
        if is_win32_separator(path[1]) {
            // `\\server\share`: one or more non-separators, separators, non-separators.
            let mut j = 2;
            let mut last = j;
            while j < len && !is_win32_separator(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = &path[last..j];
                last = j;
                while j < len && is_win32_separator(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_win32_separator(path[j]) {
                        j += 1;
                    }
                    if j == len {
                        // Only the UNC root: nothing left to normalize.
                        let mut root = units("\\\\");
                        root.extend_from_slice(first_part);
                        root.push(BACKSLASH);
                        root.extend_from_slice(&path[last..]);
                        root.push(BACKSLASH);
                        return root;
                    }
                    if j != last {
                        let mut root = units("\\\\");
                        root.extend_from_slice(first_part);
                        root.push(BACKSLASH);
                        root.extend_from_slice(&path[last..j]);
                        device = Some(root);
                        root_end = j;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if is_windows_device_root(code) && path[1] == COLON {
        device = Some(path[..2].to_vec());
        root_end = 2;
        if len > 2 && is_win32_separator(path[2]) {
            // A separator right after the drive makes it absolute.
            is_absolute = true;
            root_end = 3;
        }
    }

    let mut tail = if root_end < len {
        normalize_string(
            &path[root_end..],
            !is_absolute,
            BACKSLASH,
            is_win32_separator,
        )
    } else {
        Vec::new()
    };
    if tail.is_empty() && !is_absolute {
        tail = units(".");
    }
    if !tail.is_empty() && is_win32_separator(path[len - 1]) {
        tail.push(BACKSLASH);
    }
    let mut normalized = device.unwrap_or_default();
    if is_absolute {
        normalized.push(BACKSLASH);
    }
    normalized.extend(tail);
    normalized
}

/// Resolves `.` and `..` segments and drops empty ones, writing `separator` between what is
/// left. `..` may climb above the start only when `allow_above_root` (a relative path).
fn normalize_string(
    path: &[u16],
    allow_above_root: bool,
    separator: u16,
    is_separator: fn(u16) -> bool,
) -> Vec<u16> {
    let mut res: Vec<u16> = Vec::new();
    let mut last_segment_length = 0;
    // Indices are signed because Node starts `lastSlash` at -1 and compares it with `i - 1`.
    let mut last_slash: isize = -1;
    // The dots seen in this segment so far, or -1 once it holds anything else.
    let mut dots: isize = 0;
    let mut code: u16 = 0;
    for i in 0..=path.len() {
        if i < path.len() {
            code = path[i];
        } else if is_separator(code) {
            break;
        } else {
            // The end of the path closes the last segment like a separator.
            code = FORWARD_SLASH;
        }
        let at = i as isize;

        if is_separator(code) {
            if last_slash == at - 1 || dots == 1 {
                // An empty segment, or `.`.
            } else if dots == 2 {
                let ends_with_dot_dot = res.ends_with(&[DOT, DOT]);
                if res.len() < 2 || last_segment_length != 2 || !ends_with_dot_dot {
                    if res.len() > 2 {
                        let last_slash_index =
                            res.len() as isize - last_segment_length as isize - 1;
                        if last_slash_index == -1 {
                            res.clear();
                            last_segment_length = 0;
                        } else {
                            res.truncate(last_slash_index as usize);
                            let last_separator = res
                                .iter()
                                .rposition(|&unit| unit == separator)
                                .map_or(-1, |index| index as isize);
                            last_segment_length =
                                (res.len() as isize - 1 - last_separator) as usize;
                        }
                        last_slash = at;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = at;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend([DOT, DOT]);
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i];
                if !res.is_empty() {
                    res.push(separator);
                }
                res.extend_from_slice(segment);
                last_segment_length = (at - last_slash - 1) as usize;
            }
            last_slash = at;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}
