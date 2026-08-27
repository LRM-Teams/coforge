import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("Pi SDK creates an in-memory session on Bun", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-agent-"));
  try {
    const { session } = await createAgentSession({
      cwd: agentWorkspaceDirectory,
      agentDir: join(agentWorkspaceDirectory, ".pi-agent"),
      sessionManager: SessionManager.inMemory(agentWorkspaceDirectory),
      settingsManager: SettingsManager.inMemory(),
    });

    try {
      expect(session.sessionId).toBeString();
      expect(session.sessionFile).toBeUndefined();
    } finally {
      session.dispose();
    }
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});
