(async () => {
  const env = Bun.env;
  const billing = JSON.parse(
    env.COFORGE_GROK_BILLING ??
      '{"config":{"creditUsagePercent":42.5,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY"},"onDemandCap":{"val":0},"onDemandUsed":{"val":0},"isUnifiedBillingUser":true}}',
  );
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, authMethods: [] } })}\n`,
        );
      } else if (request.method === "_x.ai/billing") {
        if (env.COFORGE_GROK_USAGE_ERROR)
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: JSON.parse(env.COFORGE_GROK_USAGE_ERROR) })}\n`,
          );
        else
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: billing })}\n`,
          );
      } else if (request.method === "_x.ai/auth/info") {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { email: "ada@example.com" } })}\n`,
        );
      }
    }
  }
})();
