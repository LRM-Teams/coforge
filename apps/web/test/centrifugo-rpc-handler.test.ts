import { describe, expect, test } from "bun:test";
import {
  CentrifugoRpcAuthenticationError,
  CentrifugoRpcHandler,
  type CentrifugoRpcMethod,
} from "../src/server/centrifugo/rpc-handler.server";
import { createCentrifugoRpcHandler } from "../src/server/centrifugo/rpc-composition.server";

const encoded = (value: string) => btoa(value);
const json = (value: unknown) =>
  new Request("http://handler", {
    method: "POST",
    body: JSON.stringify(value),
  });
const authorizedJson = (value: unknown) =>
  new Request("http://handler", {
    method: "POST",
    headers: { "x-coforge-centrifugo-proxy-secret": "test-secret" },
    body: JSON.stringify(value),
  });

describe("CentrifugoRpcHandler", () => {
  test("composed protocol methods fail closed until persistence is wired", async () => {
    const handler = createCentrifugoRpcHandler();
    const previous = process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    process.env.COFORGE_CENTRIFUGO_PROXY_SECRET = "test-secret";
    const result = await handler.handleRequest(
      authorizedJson({ method: "workspace:list", b64data: "AA==", user: "user-1" }),
    );
    if (previous === undefined) delete process.env.COFORGE_CENTRIFUGO_PROXY_SECRET;
    expect(await result.json()).toEqual({
      error: { code: 503, message: "protocol method dependencies are unavailable" },
    });
  });

  test("rejects an unauthenticated internal proxy request", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: { echo: () => new Uint8Array([1]) },
      authorizeProxyRequest: () => {
        throw new Error("not trusted");
      },
    });
    const result = await handler.handleRequest(json({ method: "echo", b64data: "AA==" }));
    expect(await result.json()).toEqual({
      error: { code: 403, message: "RPC request is not authorized" },
    });
  });

  test("maps a missing authenticated Centrifugo user to 401", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: { echo: () => new Uint8Array([1]) },
      authenticateEnvelope: (request) => {
        if (!request.user) throw new CentrifugoRpcAuthenticationError();
      },
    });
    const result = await handler.handleRequest(json({ method: "echo", b64data: "AA==" }));
    expect(await result.json()).toEqual({
      error: { code: 401, message: "authentication required" },
    });
  });

  test("round trips binary payload and passes envelope metadata", async () => {
    const method: CentrifugoRpcMethod = (payload, metadata) => {
      expect([...payload]).toEqual([0, 255, 42]);
      expect(metadata.user).toBe("user-1");
      expect(metadata.client).toBe("connection-1");
      return payload;
    };
    const handler = new CentrifugoRpcHandler({ methods: { echo: method } });
    const result = await handler.handleRequest(
      json({ method: "echo", user: "user-1", client: "connection-1", b64data: encoded("\0ÿ*") }),
    );
    expect(await result.json()).toEqual({ result: { b64data: encoded("\0ÿ*") } });
  });

  test("rejects unknown and malformed requests", async () => {
    const handler = new CentrifugoRpcHandler({ methods: {} });
    expect(
      await (await handler.handleRequest(json({ method: "nope", b64data: "AA==" }))).json(),
    ).toEqual({ error: { code: 404, message: "unknown RPC method" } });
    expect(
      await (
        await handler.handleRequest(new Request("http://handler", { method: "POST", body: "{" }))
      ).json(),
    ).toEqual({ error: { code: 400, message: "invalid RPC request" } });
  });

  test("maps handler errors without exposing secrets", async () => {
    const handler = new CentrifugoRpcHandler({
      methods: {
        boom: () => {
          throw new Error("token=super-secret");
        },
      },
    });
    const body = JSON.stringify(
      await (await handler.handleRequest(json({ method: "boom", b64data: "AA==" }))).json(),
    );
    expect(body).toBe('{"error":{"code":500,"message":"RPC method failed"}}');
    expect(body).not.toContain("super-secret");
  });
});
