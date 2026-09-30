import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeFetch } from "#src/runtime-provider";

test("session fetch uses proxy precedence and honors exact host, wildcard, and port exclusions", async () => {
  // The bypass this asserts is the map's, but Bun's own proxy settings are the process's: an
  // environment that names loopback in `NO_PROXY` (agent sandboxes do) skips the proxy this fixture
  // stands up, so no case expecting a proxied answer can be reached. Clear the process's bypass for
  // the test and put it back; `runtimeFetch` reads only the map it is handed.
  const hostEnv = clearHostEnv(["NO_PROXY", "no_proxy"]);
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
    restoreHostEnv(hostEnv);
  }
});

test("session fetch trusts the Agent's NODE_EXTRA_CA_CERTS for a server that omits its intermediate", async () => {
  // An internal model endpoint signed by a private CA presents only its leaf, so the file must
  // carry the root and the intermediate. Bun applies the process's proxy and CA settings beside
  // the per-request ones, so the host's values are cleared here and put back afterwards.
  const hostEnv = clearHostEnv([
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_EXTRA_CA_CERTS",
  ]);
  const directory = await mkdtemp(join(tmpdir(), "coforge-extra-ca-"));
  try {
    const caBundle = await writeCertificates(directory);
    const serve = (name: string) =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: {
          cert: Bun.file(join(directory, `${name}.pem`)),
          key: Bun.file(join(directory, `${name}.key`)),
        },
        fetch: () => new Response("private"),
      });
    const server = serve("leaf");
    const other = serve("unrelated");
    const url = `https://localhost:${server.port}/probe`;
    try {
      await expect(runtimeFetch({ NO_PROXY: "*" })(url)).rejects.toMatchObject({
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      const trusted = runtimeFetch({ NO_PROXY: "*", NODE_EXTRA_CA_CERTS: caBundle });
      expect(await (await trusted(url)).text()).toBe("private");
      // The file adds trust for its own CA only; it does not turn verification off.
      await expect(trusted(`https://localhost:${other.port}/probe`)).rejects.toMatchObject({
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
    } finally {
      server.stop(true);
      other.stop(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    restoreHostEnv(hostEnv);
  }
});

test("an unreadable NODE_EXTRA_CA_CERTS names the variable and the path instead of a bare connection error", () => {
  const path = join(tmpdir(), `coforge-missing-ca-${crypto.randomUUID()}.pem`);
  expect(() => runtimeFetch({ NODE_EXTRA_CA_CERTS: path })).toThrow(
    `NODE_EXTRA_CA_CERTS names ${path}, which could not be read`,
  );
});

test("a NODE_EXTRA_CA_CERTS the daemon process already has is left to Bun, which applied it at startup", () => {
  // An Agent inherits the daemon's environment, so an unchanged value is not the Agent's own and
  // must not fail every launch where Bun only warned.
  const path = join(tmpdir(), `coforge-missing-ca-${crypto.randomUUID()}.pem`);
  const hostEnv = clearHostEnv(["NODE_EXTRA_CA_CERTS"]);
  process.env.NODE_EXTRA_CA_CERTS = path;
  try {
    expect(() => runtimeFetch({ NODE_EXTRA_CA_CERTS: path })).not.toThrow();
  } finally {
    restoreHostEnv(hostEnv);
  }
});

/**
 * Throwaway certificates for `localhost` in `directory`: root -> intermediate -> `leaf`, the
 * root + intermediate bundle, and a self-signed `unrelated` leaf outside that chain.
 */
async function writeCertificates(directory: string) {
  const openssl = Bun.which("openssl");
  if (!openssl) throw new Error("openssl is required");
  const issue = (name: string, extensions: string[], issuer?: string) => {
    const signing = issuer ? ["-CA", `${issuer}.pem`, "-CAkey", `${issuer}.key`] : [];
    const args = [
      "req",
      "-x509",
      ...signing,
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
    ];
    args.push(
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.pem`,
    );
    const result = Bun.spawnSync([openssl, ...args, ...extensions.flatMap((e) => ["-addext", e])], {
      cwd: directory,
    });
    if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
  };
  const authority = ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign"];
  const server = ["basicConstraints=critical,CA:FALSE", "subjectAltName=DNS:localhost"];
  issue("root", authority);
  issue("intermediate", authority, "root");
  issue("leaf", server, "intermediate");
  issue("unrelated", server);
  const caBundle = join(directory, "ca-bundle.pem");
  const pem = (name: string) => Bun.file(join(directory, `${name}.pem`)).text();
  await Bun.write(caBundle, (await pem("root")) + (await pem("intermediate")));
  return caBundle;
}

/** Clears these process environment variables and returns the host's values for `restoreHostEnv`. */
function clearHostEnv(names: string[]): Record<string, string | undefined> {
  const host = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  return host;
}

/** Puts process environment variables back the way the host had them, absence included. */
function restoreHostEnv(host: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
