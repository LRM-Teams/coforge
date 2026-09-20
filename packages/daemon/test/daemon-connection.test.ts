test("a rejected control publication names every decoder's reason and the payload's shape", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const { records } = await captureLogs(async () => {
    await transport.start("secret", config);
    fake.connect();
    // A length-delimited field that claims more bytes than arrived: the shape of a control frame
    // that was cut short on the wire, which no decoder can accept and none can explain.
    fake.publish(
      `daemon:${config.workspaceId}:${config.computerId}`,
      new Uint8Array([0x0a, 0x28, 0x61, 0x62, 0x63]),
    );
  });

  const rejection = records.find((record) => record.properties.event === "daemon_control:rejected");
  expect(rejection).toBeDefined();
  expect(rejection!.properties.payload_bytes).toBe(5);
  expect(rejection!.properties.payload_shape).toContain("1:len(40)");
  expect(rejection!.properties.payload_shape).toContain("truncated");
  const reasons = String(rejection!.properties.rejections);
  expect(reasons).toContain("agent_message");
  expect(reasons).toContain("agent_stop");
  expect(reasons).toContain("agent_start");
});

/** Drives the Computer status refresh by hand, with a clock this test moves itself, so the
 * connection's liveness window can be crossed without waiting for it. */
function livenessHarness(rpc: CentrifugeWorkspaceClient["rpc"]) {
  const fake = fakeClient();
  fake.client.rpc = rpc;
  const lifecycle: string[] = [];
  const connect = fake.client.connect.bind(fake.client);
  fake.client.connect = () => {
    lifecycle.push("connect");
    connect();
  };
  fake.client.disconnect = () => {
    lifecycle.push("disconnect");
    fake.disconnect();
  };
  let nowMs = 1_000_000;
  let refresh!: () => void;
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client, undefined, {
    schedule: () => 1,
    cancel: () => {},
    scheduleRepeating: (callback) => {
      refresh = callback;
      return 2;
    },
    cancelRepeating: () => {},
    now: () => nowMs,
  });
  return {
    fake,
    transport,
    lifecycle,
    advance: (ms: number) => {
      nowMs += ms;
    },
    tick: async () => {
      refresh();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("a connection carrying nothing at all is rebuilt rather than waited on", async () => {
  const harness = livenessHarness(async () => {
    throw new Error("no reply");
  });
  const { records } = await captureLogs(async () => {
    await harness.transport.start("secret", config);
    harness.lifecycle.length = 0;
    harness.advance(80_000);
    await harness.tick();
    harness.advance(80_000);
    await harness.tick();
  });

  expect(harness.lifecycle).toEqual(["disconnect", "connect"]);
  const stalled = records.find(
    (record) => record.properties.event === "daemon_connection:inbound_stalled",
  );
  expect(stalled).toBeDefined();
  expect(Number(stalled!.properties.last_inbound_age_ms)).toBeGreaterThanOrEqual(140_000);
  await harness.transport.stop();
});

test("a quiet Workspace whose status round trip still answers keeps its connection", async () => {
  const harness = livenessHarness(async () => new Uint8Array());
  await harness.transport.start("secret", config);
  harness.lifecycle.length = 0;
  for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
    harness.advance(30_000);
    await harness.tick();
  }

  expect(harness.lifecycle).toEqual([]);
  await harness.transport.stop();
});

test("a publication proves the connection carries traffic even when no decoder accepts it", async () => {
  const harness = livenessHarness(async () => {
    throw new Error("no reply");
  });
  await harness.transport.start("secret", config);
  harness.lifecycle.length = 0;
  harness.advance(80_000);
  await harness.tick();
  harness.fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    new Uint8Array([0x0a, 0x28, 0x61]),
  );
  harness.advance(80_000);
  await harness.tick();

  expect(harness.lifecycle).toEqual([]);
  await harness.transport.stop();});

test("memory exploration HTTP transport authenticates and decodes the Agent request", async () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const client = createAgentMessageHttpClient(async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({
      ok: true,
      sessionId: "session-1",
      state: "active",
      items: [{ citationId: "insight:abc", kind: "insight", id: "abc", snippet: "rule" }],
      remainingSteps: 3,
      duplicate: false,
    });
  });
  const result = await client.requestMemoryExploration!({
    url: "https://server.example/api/agent/v1/memory",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: { op: "start", startKey: "start-1", query: "backups" },
  });

  expect(result).toEqual({
    op: "start",
    sessionId: "session-1",
    state: "active",
    items: [{ citationId: "insight:abc", kind: "insight", id: "abc", snippet: "rule" }],
    remainingSteps: 3,
    duplicate: false,
  });
  expect(calls[0]?.url).toBe("https://server.example/api/agent/v1/memory");
  expect(calls[0]?.headers.get("x-coforge-agent-api-key")).toBe(
    `Bearer sk_agent_${"a".repeat(43)}`,
  );
  expect(calls[0]?.body).toEqual({ op: "start", startKey: "start-1", query: "backups" });
});

test("memory exploration HTTP transport rejects a non-ok or malformed response", async () => {
  const failing = createAgentMessageHttpClient(async () =>
    Response.json({ ok: false, errorCode: "gm-memory-explorer-only" }, { status: 403 }),
  );
  await expect(
    failing.requestMemoryExploration!({
      url: "https://server.example/api/agent/v1/memory",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: { op: "start", startKey: "start-1", query: "backups" },
    }),
  ).rejects.toThrow("Memory exploration request failed (403)");

  const malformed = createAgentMessageHttpClient(async () => Response.json({ ok: true }));
  await expect(
    malformed.requestMemoryExploration!({
      url: "https://server.example/api/agent/v1/memory",
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: { op: "start", startKey: "start-1", query: "backups" },
    }),
  ).rejects.toThrow("invalid memory exploration response");
});
