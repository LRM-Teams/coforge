import { expect, test } from "bun:test";

import { OAuthDeviceClient } from "../src/oauth-device-client";
import { ComputerLogin } from "../src/login";

test("device client discovers RFC endpoints and starts authorization", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const responses = [
    Response.json({
      issuer: "https://auth.example",
      device_authorization_endpoint: "https://auth.example/device",
      token_endpoint: "https://auth.example/token",
    }),
    Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example/activate",
      expires_in: 600,
      interval: 5,
    }),
    Response.json({ error: "authorization_pending" }, { status: 400 }),
  ];
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: init?.body?.toString() });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    },
  });

  await expect(client.authorize("https://auth.example")).resolves.toEqual({
    deviceCode: "device-secret",
    userCode: "ABCD-EFGH",
    verificationUri: "https://auth.example/activate",
    expiresInSeconds: 600,
    intervalSeconds: 5,
  });
  await expect(client.pollToken("device-secret")).resolves.toEqual({ status: "pending" });

  expect(requests).toEqual([
    { url: "https://auth.example/.well-known/oauth-authorization-server" },
    {
      url: "https://auth.example/device",
      body: "client_id=coforge-computer&scope=openid+offline_access",
    },
    {
      url: "https://auth.example/token",
      body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=device-secret&client_id=coforge-computer",
    },
  ]);
});

test("device client discovers a pathful RFC 8414 issuer", async () => {
  const requests: string[] = [];
  const responses = [
    Response.json({
      issuer: "https://auth.example/tenant",
      device_authorization_endpoint: "https://auth.example/tenant/device",
      token_endpoint: "https://auth.example/tenant/token",
    }),
    Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example/tenant/activate",
      expires_in: 600,
    }),
  ];
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
    fetch: async (input) => {
      requests.push(String(input));
      return responses.shift()!;
    },
  });

  await client.authorize("https://auth.example/tenant");

  expect(requests[0]).toBe("https://auth.example/.well-known/oauth-authorization-server/tenant");
});

test("device client rejects an unsafe verification URL", async () => {
  const responses = [
    Response.json({
      issuer: "https://auth.example",
      device_authorization_endpoint: "https://auth.example/device",
      token_endpoint: "https://auth.example/token",
    }),
    Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "javascript:alert(1)",
      expires_in: 600,
    }),
  ];
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
    fetch: async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    },
  });

  await expect(client.authorize("https://auth.example")).rejects.toThrow(
    "verification URI must use HTTPS",
  );
});

test("device client returns a canonical verification URL", async () => {
  const responses = [
    Response.json({
      issuer: "https://auth.example",
      device_authorization_endpoint: "https://auth.example/device",
      token_endpoint: "https://auth.example/token",
    }),
    Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://AUTH.EXAMPLE:443/oauth/../activate",
      expires_in: 600,
    }),
  ];
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
    fetch: async () => responses.shift()!,
  });

  await expect(client.authorize("https://auth.example")).resolves.toMatchObject({
    verificationUri: "https://auth.example/activate",
  });
});

test("device client maps cancellation and expiry to stable errors", async () => {
  for (const [oauthError, code] of [
    ["access_denied", "AUTH_DEVICE_CODE_CANCELLED"],
    ["expired_token", "AUTH_DEVICE_CODE_EXPIRED"],
  ] as const) {
    const responses = [
      Response.json({
        issuer: "https://auth.example",
        device_authorization_endpoint: "https://auth.example/device",
        token_endpoint: "https://auth.example/token",
      }),
      Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example/activate",
        expires_in: 600,
      }),
      Response.json({ error: oauthError }, { status: 400 }),
    ];
    const client = new OAuthDeviceClient({
      clientId: "coforge-computer",
      scope: "openid offline_access",
      fetch: async () => responses.shift()!,
    });

    await client.authorize("https://auth.example");
    await expect(client.pollToken("device-secret")).rejects.toMatchObject({ code });
  }
});

test("device client maps connection failures without exposing fetch diagnostics", async () => {
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
    fetch: async () => {
      throw new TypeError("connect ECONNREFUSED 10.0.0.5:443");
    },
  });

  await expect(client.authorize("https://auth.example")).rejects.toMatchObject({
    code: "AUTH_NETWORK_ERROR",
    message: "Could not reach the CoForge server.",
  });
});

test("token polling converts the runtime abort timeout into a retryable result", async () => {
  const responses = [
    Response.json({
      issuer: "https://auth.example",
      device_authorization_endpoint: "https://auth.example/device",
      token_endpoint: "https://auth.example/token",
    }),
    Response.json({
      device_code: "device-secret",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example/activate",
      expires_in: 600,
    }),
  ];
  const client = new OAuthDeviceClient({
    clientId: "coforge-computer",
    scope: "openid offline_access",
    fetch: async (_input, init) => {
      const response = responses.shift();
      if (response) return response;
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      return await new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    },
  });

  await client.authorize("https://auth.example");
  await expect(client.pollToken("device-secret", 1)).resolves.toEqual({
    status: "network_timeout",
  });
});

test("login completes against a reproducible local device-code server and lists workspaces", async () => {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
      const issuer = `http://localhost:${server.port}`;
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          device_authorization_endpoint: `${issuer}/oauth/device`,
          token_endpoint: `${issuer}/oauth/token`,
          coforge_workspaces_endpoint: `${issuer}/api/v1/workspaces`,
        });
      }
      if (url.pathname === "/oauth/device") {
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: `${issuer}/activate`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (url.pathname === "/oauth/token") {
        return Response.json({ access_token: "access-secret", token_type: "Bearer" });
      }
      if (url.pathname === "/api/v1/workspaces") {
        return Response.json({
          workspaces: [{ id: "ws_01", slug: "alpha", name: "Alpha Team" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const result = await new ComputerLogin({
      client: new OAuthDeviceClient({ clientId: "coforge-computer", scope: "openid" }),
      store: { async save() {} },
      writeLine: () => undefined,
      sleep: async () => undefined,
    }).run({ serverUrl: `http://localhost:${server.port}` });

    expect(result.workspaces).toEqual([{ id: "ws_01", slug: "alpha", name: "Alpha Team" }]);
    expect(requests).toEqual([
      { path: "/.well-known/oauth-authorization-server", authorization: null },
      { path: "/oauth/device", authorization: null },
      { path: "/oauth/token", authorization: null },
      { path: "/api/v1/workspaces", authorization: "Bearer access-secret" },
    ]);
    expect(requests.map(({ path }) => path)).not.toContain("/api/v1/workspace-bindings");
  } finally {
    server.stop(true);
  }
});
