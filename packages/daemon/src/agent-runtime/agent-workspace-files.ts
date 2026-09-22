import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getCoforgeAgentDir, getCoforgeSessionDir } from "@coforge/agent";

export type AgentWorkspaceFileEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  sizeBytes: number;
  modifiedAtMs: number;
};

export type AgentWorkspaceFilesListOutcome = {
  status: "ok" | "missing" | "unreadable" | "error";
  rootPath: string;
  entries: AgentWorkspaceFileEntry[];
};

export type AgentWorkspaceFileReadOutcome = {
  status: "ok" | "missing" | "unreadable" | "binary" | "too_large" | "error";
  sizeBytes: number;
  modifiedAtMs: number;
  text: string;
  /** The media type of `contentBase64` — sniffed from the bytes, never the file name — or `""` for
   * every read that fills `text` instead. */
  contentType: string;
  /** Standard base64 of a previewable image's bytes, or `""` for a text read. */
  contentBase64: string;
};

// Must stay under Centrifugo's websocket.message_size_limit (infra/*/centrifugo/config.yaml):
// the whole text travels in one RPC message.
const MAX_TEXT_BYTES = 1024 * 1024;
// An image travels that same single-publish path, so it is bounded by that same ceiling; past it
// the read reports `too_large` rather than risking a publish the transport would refuse.
const MAX_IMAGE_BYTES = MAX_TEXT_BYTES;
const SNIFF_BYTES = 8192;

/**
 * The magic bytes that name an image this daemon carries back for preview. Sniffed rather than
 * inferred from the file name, which the writer controls and the reader would then trust.
 *
 * Deliberately absent: BMP, whose two-byte `BM` magic is not distinctive enough to separate a
 * bitmap from prose that opens with those two letters — guessing wrong would cost the reader the
 * text they could otherwise have seen, which is worse than leaving one rare format unpreviewed.
 */
const IMAGE_SIGNATURES: ReadonlyArray<{ offset?: number; text: string; contentType: string }> = [
  { text: "\x89PNG\r\n\x1a\n", contentType: "image/png" },
  { text: "\xff\xd8\xff", contentType: "image/jpeg" },
  { text: "GIF87a", contentType: "image/gif" },
  { text: "GIF89a", contentType: "image/gif" },
  { text: "II*\x00", contentType: "image/tiff" },
  { text: "MM\x00*", contentType: "image/tiff" },
  { text: "\x00\x00\x01\x00", contentType: "image/x-icon" },
  // ISO-BMFF brands: the format is named four bytes into the `ftyp` box.
  { offset: 4, text: "ftypavif", contentType: "image/avif" },
  { offset: 4, text: "ftypavis", contentType: "image/avif" },
];

function matchesSignature(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index++)
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

/** The media type of a previewable image, or `null` for anything this daemon will not preview. */
function sniffImageContentType(bytes: Uint8Array): string | null {
  for (const signature of IMAGE_SIGNATURES)
    if (matchesSignature(bytes, signature.offset ?? 0, signature.text))
      return signature.contentType;
  // RIFF is a container, not a format: only the subtype says WebP rather than WAV or AVI.
  if (matchesSignature(bytes, 0, "RIFF") && matchesSignature(bytes, 8, "WEBP")) return "image/webp";
  return null;
}

// Directory names a workspace browse must never surface, matching the runtime's own reserved
// storage (packages/agent/src/paths.ts). Resolved through the package's exported helpers rather
// than duplicated literals, so a rename there cannot silently reopen this boundary.
const BUILTIN_DIR_NAMES = [getCoforgeAgentDir(""), getCoforgeSessionDir("")];

const emptyListEntries: AgentWorkspaceFileEntry[] = [];

function isENOENT(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT");
}

/** Defense in depth: the wire codec already rejects these shapes at decode time. */
function isSafeRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "." && segment !== "..");
}

function containsBuiltinSegment(value: string): boolean {
  return value.split("/").some((segment) => BUILTIN_DIR_NAMES.includes(segment));
}

type DirectoryResolution =
  | { ok: true; absolutePath: string; realRoot: string }
  | { ok: false; reason: "missing" | "unreadable" };

/**
 * Resolves a workspace-relative directory path to its realpath'd absolute location, refusing
 * anything that a symlink would carry outside the Agent's workspace root.
 */
async function resolveWorkspaceDirectory(
  agentWorkspaceDirectory: string,
  relativeDirPath: string,
): Promise<DirectoryResolution> {
  const root = resolve(agentWorkspaceDirectory);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    return { ok: false, reason: isENOENT(error) ? "missing" : "unreadable" };
  }
  const target = relativeDirPath === "" ? root : join(root, relativeDirPath);
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch (error) {
    return { ok: false, reason: isENOENT(error) ? "missing" : "unreadable" };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep))
    return { ok: false, reason: "unreadable" };
  return { ok: true, absolutePath: realTarget, realRoot };
}

/** Directory observation only. Never opens, follows a symlink target, or executes anything. */
export async function listAgentWorkspaceFiles(params: {
  agentWorkspaceDirectory: string;
  dirPath: string;
  includeHidden: boolean;
}): Promise<AgentWorkspaceFilesListOutcome> {
  try {
    if (!isSafeRelativePath(params.dirPath) || containsBuiltinSegment(params.dirPath))
      return { status: "unreadable", rootPath: "", entries: emptyListEntries };
    const resolved = await resolveWorkspaceDirectory(
      params.agentWorkspaceDirectory,
      params.dirPath,
    );
    if (!resolved.ok) return { status: resolved.reason, rootPath: "", entries: emptyListEntries };
    let names: string[];
    try {
      names = await readdir(resolved.absolutePath);
    } catch (error) {
      return {
        status: isENOENT(error) ? "missing" : "unreadable",
        rootPath: "",
        entries: emptyListEntries,
      };
    }
    const entries: AgentWorkspaceFileEntry[] = [];
    for (const name of names) {
      if (BUILTIN_DIR_NAMES.includes(name)) continue;
      if (!params.includeHidden && name.startsWith(".")) continue;
      try {
        const info = await lstat(join(resolved.absolutePath, name));
        const type: AgentWorkspaceFileEntry["type"] = info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "dir"
            : info.isFile()
              ? "file"
              : "other";
        entries.push({
          name,
          type,
          sizeBytes: info.size,
          modifiedAtMs: Math.round(info.mtimeMs),
        });
      } catch {
        // An entry that vanished or cannot be stat'd between readdir and lstat is skipped
        // rather than failing the whole listing.
      }
    }
    entries.sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return {
      status: "ok",
      rootPath: params.dirPath === "" ? resolved.realRoot : "",
      entries,
    };
  } catch {
    return { status: "error", rootPath: "", entries: emptyListEntries };
  }
}

/** Read-only file observation. Never follows a symlink for the final path component. */
export async function readAgentWorkspaceFile(params: {
  agentWorkspaceDirectory: string;
  path: string;
}): Promise<AgentWorkspaceFileReadOutcome> {
  const empty = { sizeBytes: 0, modifiedAtMs: 0, text: "", contentType: "", contentBase64: "" };
  try {
    if (!isSafeRelativePath(params.path) || containsBuiltinSegment(params.path))
      return { status: "unreadable", ...empty };
    const separatorIndex = params.path.lastIndexOf("/");
    const dirPart = separatorIndex === -1 ? "" : params.path.slice(0, separatorIndex);
    const baseName = separatorIndex === -1 ? params.path : params.path.slice(separatorIndex + 1);
    const resolvedDir = await resolveWorkspaceDirectory(params.agentWorkspaceDirectory, dirPart);
    if (!resolvedDir.ok) return { status: resolvedDir.reason, ...empty };
    const fullPath = join(resolvedDir.absolutePath, baseName);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      // O_NOFOLLOW refuses to open the final component if it is itself a symlink.
      file = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      return { status: isENOENT(error) ? "missing" : "unreadable", ...empty };
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) return { status: "unreadable", ...empty };
      const sizeBytes = info.size;
      const modifiedAtMs = Math.round(info.mtimeMs);
      const sniffLength = Math.min(SNIFF_BYTES, sizeBytes);
      let sniff = Buffer.alloc(0);
      if (sniffLength > 0) {
        const head = Buffer.alloc(sniffLength);
        const { bytesRead } = await file.read(head, 0, sniffLength, 0);
        sniff = head.subarray(0, bytesRead);
      }
      // An image is decided before the NUL test below, because compressed image data routinely
      // carries NUL bytes: the binary rule would otherwise answer first and the reader would never
      // see the picture.
      const contentType = sniffImageContentType(sniff);
      if (contentType) {
        if (sizeBytes > MAX_IMAGE_BYTES)
          return {
            status: "too_large",
            sizeBytes,
            modifiedAtMs,
            text: "",
            contentType: "",
            contentBase64: "",
          };
        const buffer = Buffer.alloc(sizeBytes);
        if (sizeBytes > 0) await file.read(buffer, 0, sizeBytes, 0);
        return {
          status: "ok",
          sizeBytes,
          modifiedAtMs,
          text: "",
          contentType,
          contentBase64: buffer.toString("base64"),
        };
      }
      if (sniff.includes(0))
        return {
          status: "binary",
          sizeBytes,
          modifiedAtMs,
          text: "",
          contentType: "",
          contentBase64: "",
        };
      if (sizeBytes > MAX_TEXT_BYTES)
        return {
          status: "too_large",
          sizeBytes,
          modifiedAtMs,
          text: "",
          contentType: "",
          contentBase64: "",
        };
      const buffer = Buffer.alloc(sizeBytes);
      if (sizeBytes > 0) await file.read(buffer, 0, sizeBytes, 0);
      return {
        status: "ok",
        sizeBytes,
        modifiedAtMs,
        text: buffer.toString("utf8"),
        contentType: "",
        contentBase64: "",
      };
    } finally {
      await file.close();
    }
  } catch {
    return { status: "error", ...empty };
  }
}
