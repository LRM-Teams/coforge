/**
 * Every Daemon test process keeps its Agents' CLI temporary state in a directory of its own.
 *
 * The send-draft and consumed-cursor stores default to one directory per OS user under `tmpdir()`,
 * shared by every process of that user: other test processes running at the same time (another
 * worktree's suite, say) and a live Daemon on the same machine. Tests that write or clear that
 * state would then read, overwrite, and delete each other's. The stores' documented overrides point
 * this process at a fresh directory instead, and it is removed after the last test file.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS tmpdir lives under /var, a symlink; the state stores reject linked ancestors.
const root = mkdtempSync(join(realpathSync(tmpdir()), "coforge-daemon-test-cli-state-"));
process.env.COFORGE_CLI_DRAFT_STATE_DIR = root;
process.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = root;

afterAll(() => rm(root, { recursive: true, force: true }));
