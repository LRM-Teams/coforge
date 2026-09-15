import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OSS from "ali-oss";

import { buildReleaseTree, type ReleaseInputs, type ReleaseTree } from "./build-release";
import type { ReleaseTarget } from "./compile-targets";
import {
  assertVersionIsUnpublished,
  createOssClient,
  regionFromEndpoint,
  LATEST_OBJECT_KEY,
  manifestObjectKey,
  parseTargets,
  runCli,
  runPublish,
  uploadReleaseTree,
  type CompileFn,
  type OssConnection,
  type OssCredentials,
} from "./publish";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const CREDENTIALS: OssCredentials = { accessKeyId: "testkey", accessKeySecret: "testsecret" };
const BUCKET = "coforge-releases-test";
// The fixture host names no region, so tests pass one explicitly; the real bucket's region is
// derived from its endpoint (see the `regionFromEndpoint` test).
const REGION = "oss-cn-beijing";
// `windows-x64` is here for one reason: it sorts after "manifest.json", so it is what makes the
// manifest-last upload order load-bearing. With only the POSIX targets (all of which sort before
// `m`) `tree.files` already ends with the manifest, and reverting publish.ts to upload in plain
// `tree.files` order passes every test in this file. Compilation is stubbed, so the extra target
// costs nothing.
const TEST_TARGETS = ["linux-x64", "darwin-arm64", "windows-x64"];

function fixtureArtifacts(): Record<string, { computer: Uint8Array }> {
  const artifacts: Record<string, { computer: Uint8Array }> = {};
  for (const target of TEST_TARGETS) {
    artifacts[target] = {
      computer: Buffer.from(`#!/bin/sh\n# unified computer for ${target}\n`),
    };
  }
  return artifacts;
}

async function fixtureTree(version: string, outputDirectory: string): Promise<ReleaseTree> {
  const inputs: ReleaseInputs = {
    version,
    commit: "a".repeat(40),
    buildDate: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    artifacts: fixtureArtifacts(),
  };
  return buildReleaseTree(inputs, outputDirectory);
}

/** A fake OSS origin. It does not attempt to re-verify the V4 signature ali-oss puts on every
 * authenticated request - that is the SDK's responsibility, not this script's, so there is
 * nothing left here to pin against. It still distinguishes an authenticated call (has an
 * `authorization` header) from the anonymous ones `verifyPrivateOrigin` makes on purpose, since
 * that distinction is publish.ts's own behavior. */
interface FakeOssOptions {
  failUploadKeys?: Set<string>;
  tamperReadbackKeys?: Set<string>;
  publicOriginKeys?: Set<string>;
  previousLatest?: string;
  /** Objects that already exist in the bucket before the publish starts. */
  preexistingKeys?: Set<string>;
  /** Keys whose existence probe answers with an ambiguous status instead of 200/404. */
  failProbeKeys?: Set<string>;
}

interface FakeOss {
  baseUrl: string;
  calls: Array<{ method: string; key: string }>;
  /** The `authorization` header value ali-oss sent with each entry in `calls`, in the same order
   * (`undefined` for the anonymous `ANONYMOUS_GET` calls). */
  authHeaders: Array<string | undefined>;
  /** Reads the fixture's in-memory store directly, bypassing HTTP - used to assert the final
   * state of `latest` after a rollback without needing a second signed client round trip. */
  peek(key: string): Uint8Array | undefined;
}

function startFakeOssServer(options: FakeOssOptions = {}): FakeOss {
  const store = new Map<string, Uint8Array>();
  for (const key of options.preexistingKeys ?? []) store.set(key, new Uint8Array([0x7b, 0x7d]));
  if (options.previousLatest) store.set("latest", new TextEncoder().encode(options.previousLatest));
  const calls: Array<{ method: string; key: string }> = [];
  const authHeaders: Array<string | undefined> = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const objectKey = url.pathname.slice(1);
      const method = request.method;
      const authorization = request.headers.get("authorization") ?? undefined;
      const anonymous = method === "GET" && !authorization;
      calls.push({ method: anonymous ? "ANONYMOUS_GET" : method, key: objectKey });
      authHeaders.push(authorization);

      if (anonymous) {
        return new Response("origin", {
          status: options.publicOriginKeys?.has(objectKey) ? 200 : 403,
        });
      }

      if (method === "DELETE") {
        store.delete(objectKey);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        if (options.failUploadKeys?.has(objectKey)) {
          return new Response("<Error><Code>InternalError</Code></Error>", {
            status: 500,
            headers: { "x-oss-request-id": "fake-request-id-upload-fail" },
          });
        }
        store.set(objectKey, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }

      if (method === "HEAD") {
        if (options.failProbeKeys?.has(objectKey)) {
          return new Response(null, {
            status: 403,
            headers: { "x-oss-request-id": "fake-request-id-probe-fail" },
          });
        }
        return new Response(null, { status: store.has(objectKey) ? 200 : 404 });
      }

      if (method === "GET") {
        const stored = store.get(objectKey);
        if (!stored) {
          return new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "x-oss-request-id": "fake-request-id-missing" },
          });
        }
        if (
          options.tamperReadbackKeys?.has(objectKey) &&
          new TextDecoder().decode(stored) !== options.previousLatest
        ) {
          const tampered = new Uint8Array(stored.byteLength + 1);
          tampered.set(stored);
          tampered[stored.byteLength] = 0xff;
          return new Response(tampered);
        }
        return new Response(stored);
      }

      return new Response("method not allowed", { status: 405 });
    },
  });
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    authHeaders,
    peek: (key) => store.get(key),
  };
}

/** A fixture endpoint reached like the real bucket - direct HTTP to the fake server's host, no
 * bucket-name-prefixed virtual hosting (`cname: true`), over plain HTTP (`secure: false`). */
function fixtureConnection(fake: FakeOss, bucket = BUCKET): OssConnection {
  return { bucket, endpoint: fake.baseUrl, region: REGION, cname: true, secure: false };
}

/** A fake OSS origin that fails every authenticated request the same way, independent of what
 * credentials signed it - used only by the credential-leak test below, which cares whether
 * publish.ts ever prints a failure response's body/headers, not whether the SDK's own V4 signing
 * is correct (that's ali-oss's and Alibaba Cloud's problem, not this script's). */
function startLeakFixtureServer(body: string): { baseUrl: string } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const anonymous = request.method === "GET" && !request.headers.has("authorization");
      if (anonymous) return new Response("origin", { status: 403 });
      return new Response(body, {
        status: 403,
        headers: { "x-oss-request-id": "fake-request-id-signature" },
      });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}` };
}

function stubCompile(): CompileFn {
  const artifacts = fixtureArtifacts();
  return (async ({ target }) => {
    const fixture = artifacts[target];
    if (!fixture) throw new Error(`no fixture artifact for target: ${target}`);
    return fixture;
  }) as CompileFn;
}

/* ------------------------------------------------------------------------------------------- */
/* 1. Ordering: latest is written last, and only after every object is verified                 */
/* ------------------------------------------------------------------------------------------- */

test("publication uploads every object, verifies it by reading the bytes back, and writes latest last", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-publish-ok", outputDirectory);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client: OSS = await createOssClient(connection, CREDENTIALS);

  const result = await uploadReleaseTree(outputDirectory, tree, { client, connection });

  expect(result.latestKey).toBe(LATEST_OBJECT_KEY);
  expect(result.uploaded).toEqual(tree.files);

  // The manifest is uploaded last, after every binary, so that its presence means "this version
  // is complete" - which is exactly what the republish guard's HEAD probe reads.
  const manifestKey = manifestObjectKey(tree.version);
  const expectedSequence = [
    { method: "HEAD", key: manifestKey },
    ...tree.files.filter((key) => key !== manifestKey).map((key) => ({ method: "PUT", key })),
    { method: "PUT", key: manifestKey },
    ...tree.files.map((key) => ({ method: "GET", key })),
    ...tree.files.map((key) => ({ method: "ANONYMOUS_GET", key })),
    { method: "HEAD", key: LATEST_OBJECT_KEY },
    { method: "PUT", key: LATEST_OBJECT_KEY },
    { method: "GET", key: LATEST_OBJECT_KEY },
    { method: "ANONYMOUS_GET", key: LATEST_OBJECT_KEY },
  ];
  expect(fake.calls).toEqual(expectedSequence);

  const latestPutIndex = fake.calls.findIndex(
    (call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY,
  );
  for (const call of fake.calls) {
    if (call.key === LATEST_OBJECT_KEY) continue;
    expect(fake.calls.indexOf(call)).toBeLessThan(latestPutIndex);
  }

  // Every authenticated request is V4-signed by the SDK; the anonymous origin-privacy probes
  // publish.ts makes on purpose carry no Authorization header at all.
  fake.calls.forEach((call, index) => {
    if (call.method === "ANONYMOUS_GET") {
      expect(fake.authHeaders[index]).toBeUndefined();
    } else {
      // The credential scope names the bucket's region: OSS rejects a scope for another region
      // with InvalidArgument, which is exactly what happened when the client defaulted to
      // ali-oss's oss-cn-hangzhou.
      expect(fake.authHeaders[index]).toMatch(
        /^OSS4-HMAC-SHA256 Credential=testkey\/\d{8}\/cn-beijing\/oss\/aliyun_v4_request,/,
      );
    }
  });

  // The bytes actually landed, not only that the SDK reported success.
  const roundTrip = await client.get(manifestKey);
  const local = await readFile(join(outputDirectory, manifestKey));
  expect(Buffer.compare(roundTrip.content as Buffer, local)).toBe(0);
});

test("a failed object upload never writes latest, and stops before uploading later objects", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-upload-fail", outputDirectory);
  // Fail the first object actually uploaded - the manifest is deferred to last, so it is not it.
  const failingKey = tree.files.find((key) => key !== manifestObjectKey(tree.version));
  if (!failingKey) throw new Error("fixture tree produced no files");
  const fake = startFakeOssServer({ failUploadKeys: new Set([failingKey]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS upload failed: HTTP 500/,
  );

  expect(fake.calls).toEqual([
    { method: "HEAD", key: manifestObjectKey(tree.version) },
    { method: "PUT", key: failingKey },
  ]);
  // A publish that dies mid-upload must not leave the manifest behind, or the version would be
  // permanently burned by its own failure instead of being retryable.
  expect(
    fake.calls.some((call) => call.method === "PUT" && call.key.endsWith("manifest.json")),
  ).toBe(false);
  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(false);
});

test("republishing a version that already completed is refused before anything is uploaded", async () => {
  const outputDirectory = await tempDir("coforge-publish-republish-");
  const tree = await fixtureTree("9.9.9-already-live", outputDirectory);
  const fake = startFakeOssServer({
    preexistingKeys: new Set([manifestObjectKey(tree.version)]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /9\.9\.9-already-live is already published/,
  );

  // The point of the guard is that a live version's bytes are never touched: the CDN caches
  // `<version>/*` for a year, so a second publish would leave different bytes on different edges.
  expect(fake.calls).toEqual([{ method: "HEAD", key: manifestObjectKey(tree.version) }]);
});

test("a version left half-uploaded by an earlier failure can still be published", async () => {
  const outputDirectory = await tempDir("coforge-publish-retry-");
  const tree = await fixtureTree("9.9.9-retry-ok", outputDirectory);
  // A partial publish uploaded some binaries but never reached the manifest, which is exactly
  // what the manifest-last ordering guarantees. That version must remain publishable.
  const partial = tree.files.find((key) => key !== manifestObjectKey(tree.version));
  if (!partial) throw new Error("fixture tree produced no files");
  const fake = startFakeOssServer({ preexistingKeys: new Set([partial]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  const result = await uploadReleaseTree(outputDirectory, tree, { client, connection });

  expect(result.latestKey).toBe(LATEST_OBJECT_KEY);
});

test("an ambiguous existence probe aborts the publish instead of reading as absent", async () => {
  const outputDirectory = await tempDir("coforge-publish-probe-fail-");
  const tree = await fixtureTree("9.9.9-probe-fail", outputDirectory);
  const fake = startFakeOssServer({
    failProbeKeys: new Set([manifestObjectKey(tree.version)]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  // A 403 must not be mistaken for "not published yet" - that would overwrite a live version on a
  // transient credential or permission fault.
  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS probe failed: HTTP 403/,
  );

  expect(fake.calls.every((call) => call.method === "HEAD")).toBe(true);
});

test("assertVersionIsUnpublished resolves for a version the feed has never seen", async () => {
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await assertVersionIsUnpublished("1.2.3-fresh", { client });

  expect(fake.calls).toEqual([{ method: "HEAD", key: "1.2.3-fresh/manifest.json" }]);
});

/* ------------------------------------------------------------------------------------------- */
/* 2. Read-back verification                                                                     */
/* ------------------------------------------------------------------------------------------- */

test("a tampered read-back fails the publish and never writes latest", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-readback-fail", outputDirectory);
  const tamperedKey = tree.files.find((file) => file.endsWith("manifest.json"));
  if (!tamperedKey) throw new Error("fixture tree has no manifest.json");
  const fake = startFakeOssServer({ tamperReadbackKeys: new Set([tamperedKey]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS read-back mismatch: .*manifest\.json/,
  );

  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(false);
  // Every object was still uploaded before the mismatch was caught - only the read-back phase,
  // which runs after every upload, is where this fails.
  expect(
    fake.calls.filter((call) => call.method === "PUT" && call.key !== LATEST_OBJECT_KEY).length,
  ).toBe(tree.files.length);
});

/* ------------------------------------------------------------------------------------------- */
/* 3. Private-origin gate and rollback                                                           */
/* ------------------------------------------------------------------------------------------- */

test("public origin blocks activation even after signed OSS verification succeeds", async () => {
  const directory = await tempDir("coforge-delivery-gate-");
  const tree = await fixtureTree("9.9.9-delivery-gate", directory);
  const key = manifestObjectKey(tree.version);
  const fake = startFakeOssServer({ publicOriginKeys: new Set([key]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(directory, tree, { client, connection })).rejects.toThrow(
    /Private origin verification failed/,
  );
  expect(fake.calls).toContainEqual({ method: "GET", key });
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === "latest")).toBe(false);
});

for (const previousLatest of ["0.1.0-rc.3\n", undefined]) {
  test(`latest OSS read-back failure restores ${previousLatest ? "previous version" : "empty bootstrap"}`, async () => {
    const directory = await tempDir("coforge-selector-gate-");
    const tree = await fixtureTree("9.9.9-selector-gate", directory);
    const fake = startFakeOssServer({
      previousLatest,
      tamperReadbackKeys: new Set(["latest"]),
    });
    const connection = fixtureConnection(fake);
    const client = await createOssClient(connection, CREDENTIALS);

    await expect(uploadReleaseTree(directory, tree, { client, connection })).rejects.toThrow(
      /activation failed.*restored/,
    );

    const restored = fake.peek(LATEST_OBJECT_KEY);
    if (previousLatest) {
      expect(restored && new TextDecoder().decode(restored)).toBe(previousLatest);
    } else {
      expect(restored).toBeUndefined();
    }
  });
}

test("private origin network failures are sanitized", async () => {
  const directory = await tempDir("coforge-origin-error-");
  const tree = await fixtureTree("9.9.9-origin-error", directory);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(
    uploadReleaseTree(directory, tree, {
      client,
      connection,
      fetchImpl: async (input, init) => {
        if (init?.credentials === "omit") throw new Error("secret origin URL Authorization token");
        return fetch(input, init);
      },
    }),
  ).rejects.toThrow(/^Private origin verification failed: 9\.9\.9-origin-error\//);
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === "latest")).toBe(false);
});

test("public activated and restored latest fails private origin verification", async () => {
  const directory = await tempDir("coforge-latest-origin-");
  const tree = await fixtureTree("9.9.9-latest-origin", directory);
  const fake = startFakeOssServer({ previousLatest: "0.1.0-rc.3\n" });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  let probes = 0;

  await expect(
    uploadReleaseTree(directory, tree, {
      client,
      connection,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/latest") && init?.credentials === "omit") {
          probes += 1;
          if (probes > 1) return new Response("public", { status: 200 });
        }
        return fetch(input, init);
      },
    }),
  ).rejects.toThrow(/rollback could not be verified/);
  expect(probes).toBe(3);
});

test("rollback failure is reported instead of claiming the previous selector is restored", async () => {
  const directory = await tempDir("coforge-rollback-failure-");
  const tree = await fixtureTree("9.9.9-rollback-failure", directory);
  const fake = startFakeOssServer({
    previousLatest: "0.1.0-rc.3\n",
    failUploadKeys: new Set(["latest"]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(directory, tree, { client, connection })).rejects.toThrow(
    /rollback could not be verified/,
  );
});

/* ------------------------------------------------------------------------------------------- */
/* 4. Credential redaction                                                                       */
/* ------------------------------------------------------------------------------------------- */

test("a failed publish never prints the access key, secret, or an Authorization header value", async () => {
  const version = "9.9.9-leak-check";
  const wrongSecret = "not-the-real-secret";
  // A real OSS `SignatureDoesNotMatch` error body echoes back `StringToSign`, the supplied
  // `Signature`/`Authorization`, and the `AccessKeyId` - exactly the kind of response this test
  // proves publish.ts never surfaces, independent of whether the credentials that produced it
  // were actually wrong (verifying the SDK's own V4 signing is out of scope here).
  const leakBody =
    `<Error><Code>SignatureDoesNotMatch</Code>` +
    `<AccessKeyId>${CREDENTIALS.accessKeyId}</AccessKeyId>` +
    `<StringToSign>fake-string-to-sign</StringToSign>` +
    `<AuthorizationProvided>OSS4-HMAC-SHA256 Credential=${CREDENTIALS.accessKeyId},Signature=deadbeef</AuthorizationProvided>` +
    `<Message>wrong secret ${wrongSecret}</Message></Error>`;
  const fake = startLeakFixtureServer(leakBody);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));

  const previousEnv = {
    id: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    secret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
  };
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = wrongSecret;

  let exitCode: number;
  try {
    exitCode = await runCli(
      [
        "--version",
        version,
        "--feed-url",
        "https://releases-test.coforge.cn",
        "--bucket",
        BUCKET,
        "--targets",
        TEST_TARGETS.join(","),
        "--commit",
        "a".repeat(40),
      ],
      {
        compile: stubCompile(),
        connection: { endpoint: fake.baseUrl, cname: true, secure: false },
      },
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreEnvVar("ALIBABA_CLOUD_ACCESS_KEY_ID", previousEnv.id);
    restoreEnvVar("ALIBABA_CLOUD_ACCESS_KEY_SECRET", previousEnv.secret);
  }

  expect(exitCode).toBe(1);
  const combined = [...stdout, ...stderr].join("\n");
  expect(combined).not.toContain(wrongSecret);
  expect(combined).not.toContain(CREDENTIALS.accessKeySecret);
  // The key id is not a secret the way the secret is, but a real OSS error body echoes it back
  // alongside StringToSign, so printing one is the same mistake as printing the other.
  expect(combined).not.toContain(CREDENTIALS.accessKeyId);
  expect(combined.toLowerCase()).not.toContain("authorization");
  expect(combined).not.toContain("StringToSign");
});

function restoreEnvVar(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/* ------------------------------------------------------------------------------------------- */
/* 5. Dry run                                                                                     */
/* ------------------------------------------------------------------------------------------- */

test("--dry-run makes no network calls and reports the objects it would publish", async () => {
  let fetchCalls = 0;
  const throwingFetch: typeof fetch = (() => {
    fetchCalls += 1;
    throw new Error("dry-run must never call fetch");
  }) as typeof fetch;

  const outcome = await runPublish(
    {
      version: "9.9.9-dry-run",
      commit: "a".repeat(40),
      feedUrl: "https://releases-test.coforge.cn",
      targets: TEST_TARGETS as ReleaseTarget[],
      bucket: BUCKET,
      endpoint: "oss-cn-beijing.aliyuncs.com",
      dryRun: true,
    },
    { compile: stubCompile(), fetchImpl: throwingFetch },
  );

  expect(fetchCalls).toBe(0);
  expect(outcome.dryRun).toBe(true);
  expect(outcome.version).toBe("9.9.9-dry-run");
  expect(outcome.files).toContain("9.9.9-dry-run/manifest.json");
  expect(outcome.files).toContain("9.9.9-dry-run/linux-x64/coforge-computer.gz");
  expect(outcome.files).toContain("9.9.9-dry-run/linux-x64/coforge-computer.sha256");
  expect(outcome.files).not.toContain("9.9.9-dry-run/linux-x64/coforge-computer");
  expect(outcome.files.some((file) => file.includes("coforge-daemon"))).toBe(false);
  expect(outcome.latestKey).toBe(LATEST_OBJECT_KEY);
});

/* ------------------------------------------------------------------------------------------- */
/* CLI argument parsing                                                                          */
/* ------------------------------------------------------------------------------------------- */

test("parseTargets defaults to all six release platforms and validates unknown ones", () => {
  expect(parseTargets(undefined)).toEqual([
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ]);
  expect(parseTargets("linux-x64, darwin-arm64")).toEqual(["linux-x64", "darwin-arm64"]);
  expect(() => parseTargets("linux-x64,bogus")).toThrow(/unsupported release target: bogus/);
});

test("runCli requires --version and --feed-url, and rejects a non-https feed URL", async () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    expect(await runCli(["--feed-url", "https://releases-test.coforge.cn", "--dry-run"])).toBe(1);
    expect(await runCli(["--version", "1.0.0", "--dry-run"])).toBe(1);
    expect(
      await runCli([
        "--version",
        "1.0.0",
        "--feed-url",
        "http://releases-test.coforge.cn",
        "--dry-run",
      ]),
    ).toBe(1);
    expect(errors.some((line) => line.includes("--version is required"))).toBe(true);
    expect(errors.some((line) => line.includes("--feed-url is required"))).toBe(true);
    expect(errors.some((line) => line.includes("https://"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("regionFromEndpoint reads the region a public OSS endpoint names and nothing else", async () => {
  expect(regionFromEndpoint("oss-cn-beijing.aliyuncs.com")).toBe("oss-cn-beijing");
  expect(regionFromEndpoint("https://oss-cn-beijing-internal.aliyuncs.com")).toBe("oss-cn-beijing");
  expect(regionFromEndpoint("http://127.0.0.1:4567")).toBeUndefined();
  expect(regionFromEndpoint("files.coforge.cn")).toBeUndefined();
  await expect(
    createOssClient(
      { bucket: BUCKET, endpoint: "http://127.0.0.1:4567", cname: true },
      CREDENTIALS,
    ),
  ).rejects.toThrow("cannot derive the OSS region");
});
