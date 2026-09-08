import { expect, test } from "bun:test";
import { daemonConnectionEndpoint } from "../src/connection/built-server";

test("daemon derives its WSS endpoint from the built HTTP server", () => {
  expect(daemonConnectionEndpoint("https://staging.coforge.example/api")).toBe(
    "wss://staging.coforge.example/connection/websocket",
  );
});
