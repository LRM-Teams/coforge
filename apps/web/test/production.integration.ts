import { expect, test } from "bun:test";

// Run from the runtime image's /app directory, without source or workspace
// node_modules. A successful Vite build alone does not prove SSR can initialize.
test("production image serves health and both deployment-specific installers", async () => {
  const server = Bun.spawn([process.execPath, ".output/server/index.mjs"], {
    env: {
      PATH: Bun.env.PATH,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "3000",
      COFORGE_RELEASE_FEED_URL: "https://releases-staging.coforge.cn",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const errors = new Response(server.stderr).text();
  try {
    let health: Response | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        health = await fetch("http://127.0.0.1:3000/health", {
          redirect: "manual",
          signal: AbortSignal.timeout(1_000),
        });
        break;
      } catch {
        if (server.exitCode !== null) break;
        await Bun.sleep(50);
      }
    }
    expect(health?.status).toBe(200);
    expect(await health?.text()).toBe("ok");
    for (const [extension, anchor] of [
      ["sh", 'default_feed_url="https://releases-staging.coforge.cn"'],
      ["ps1", '$defaultFeedUrl = "https://releases-staging.coforge.cn"'],
    ]) {
      const response = await fetch(`http://127.0.0.1:3000/computer/install.${extension}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const body = await response.text();
      expect(body).toContain(anchor);
      expect(body).not.toContain("https://releases.coforge.cn");
      if (extension === "sh") expect(body.startsWith("#!/bin/sh")).toBe(true);
    }
  } finally {
    server.kill();
    await server.exited;
    // This process receives fixture configuration only, never deployment secrets.
    const stderr = await errors;
    if (stderr) console.error(stderr.slice(-8_192));
  }
}, 15_000);
