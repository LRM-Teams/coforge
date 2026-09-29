import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RPC_PAYLOAD_MAX_BYTES, boundedPayload } from "./bounded-payload";

/**
 * Guards the relationship the whole-result payload bounds depend on.
 *
 * An RPC result travels as a single Centrifugo publish, and a payload at or over the configured
 * `websocket.message_size_limit` makes Centrifugo close the socket with "message too big" — final,
 * which the client never reconnects from, so the Computer silently stops receiving Agent control.
 * `RPC_PAYLOAD_MAX_BYTES` is the SDK's single statement of the bound a whole result stays under;
 * this test fails if it stops being under the limit the deployment configures, which a config edit
 * and a constant edit can each cause on their own.
 */
const REPO_ROOT = join(import.meta.dir, "../../../..");
const CONFIGS: readonly string[] = [
  "infra/centrifugo/config.yaml",
  "infra/staging/centrifugo/config.yaml",
];

/** The `message_size_limit` the top-level `websocket:` block configures. */
function messageSizeLimit(config: string): number {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => /^websocket:\s*$/.test(line));
  if (start < 0) throw new Error("no top-level websocket: block");
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the websocket: block
    const match = /^ {2}message_size_limit:\s*(\d+)\s*$/.exec(line);
    if (match) return Number(match[1]);
  }
  throw new Error("no message_size_limit in the websocket: block");
}

test("a whole-result payload bound stays under every configured message_size_limit", async () => {
  for (const path of CONFIGS) {
    const limit = messageSizeLimit(await readFile(join(REPO_ROOT, path), "utf8"));
    // Strictly below: the message carries the result plus its envelope fields.
    expect({ path, belowLimit: RPC_PAYLOAD_MAX_BYTES < limit }).toEqual({ path, belowLimit: true });
  }
});

test("boundedPayload enforces exactly that bound", () => {
  expect(
    boundedPayload(new Uint8Array(RPC_PAYLOAD_MAX_BYTES), RPC_PAYLOAD_MAX_BYTES, "x").length,
  ).toBe(RPC_PAYLOAD_MAX_BYTES);
  expect(() =>
    boundedPayload(new Uint8Array(RPC_PAYLOAD_MAX_BYTES + 1), RPC_PAYLOAD_MAX_BYTES, "x"),
  ).toThrow("x payload too large");
});
