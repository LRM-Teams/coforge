import { expect, test } from "bun:test";
import { runtimeFetch } from "#src/runtime-provider";

test("session fetch uses proxy precedence and honors exact host, wildcard, and port exclusions", async () => {
  // The bypass this asserts is the map's, but Bun's own proxy settings are the process's: an
  // environment that names loopback in `NO_PROXY` (agent sandboxes do) skips the proxy this fixture
  // stands up, so no case expecting a proxied answer can be reached. Clear the process's bypass for
  // the test and put it back; `runtimeFetch` reads only the map it is handed.
  const hostNoProxy = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
  const target = Bun.serve({ port: 0, fetch: () => new Response("direct") });
  const upper = Bun.serve({ port: 0, fetch: () => new Response("upper") });
  const lower = Bun.serve({ port: 0, fetch: () => new Response("lower") });
  const url = new URL(`http://127.0.0.1:${target.port}/probe`);
  const proxy = `http://127.0.0.1:${upper.port}`;
  const cases: Array<[Record<string, string>, string]> = [
    [{ HTTP_PROXY: proxy }, "upper"],
    [{ HTTP_PROXY: proxy, http_proxy: `http://127.0.0.1:${lower.port}` }, "lower"],
    [{ ALL_PROXY: proxy }, "upper"],
    [{ HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1" }, "direct"],
    [{ HTTP_PROXY: proxy, NO_PROXY: "27.0.0.1" }, "upper"],
    [{ HTTP_PROXY: proxy, NO_PROXY: `127.0.0.1:${target.port}` }, "direct"],
    [{ HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1:1" }, "upper"],
    [{ HTTP_PROXY: proxy, NO_PROXY: "*" }, "direct"],
    [{ HTTP_PROXY: proxy, NO_PROXY: ".0.0.1" }, "direct"],
    [{ HTTP_PROXY: proxy, NO_PROXY: "other.invalid", no_proxy: "127.0.0.1" }, "direct"],
  ];
  try {
    for (const [environment, expected] of cases) {
      expect(await (await runtimeFetch(environment)(url)).text()).toBe(expected);
    }
    expect(await (await runtimeFetch({ HTTP_PROXY: proxy })(new Request(url))).text()).toBe(
      "upper",
    );
  } finally {
    target.stop(true);
    upper.stop(true);
    lower.stop(true);
    restoreHostEnv("NO_PROXY", hostNoProxy.upper);
    restoreHostEnv("no_proxy", hostNoProxy.lower);
  }
});

/** Put a process environment variable back the way the host had it, absence included. */
function restoreHostEnv(name: "NO_PROXY" | "no_proxy", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
