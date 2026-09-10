import { expect, test } from "bun:test";
import { runtimeFetch } from "../src/runtime-provider";

test("session fetch uses proxy precedence and honors exact host, wildcard, and port exclusions", async () => {
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
  }
});
