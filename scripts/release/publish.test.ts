import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReleaseTree, type ReleaseInputs, type ReleaseTree } from "./build-release";
import type { ReleaseTarget } from "./compile-targets";
import {
  DEFAULT_TARGETS,
  LATEST_OBJECT_KEY,
  ossAuthorizationHeader,
  ossSignature,
  ossStringToSign,
  parseTargets,
  runCli,
  runPublish,
  uploadReleaseTree,
  type CompileFn,
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
const TEST_TARGETS = ["linux-x64", "darwin-arm64"];

function fixtureArtifacts(): Record<string, { computer: Uint8Array; daemon: Uint8Array }> {
  const artifacts: Record<string, { computer: Uint8Array; daemon: Uint8Array }> = {};
  for (const target of TEST_TARGETS) {
    artifacts[target] = {
      computer: Buffer.from(`#!/bin/sh\n# computer for ${target}\n`),
      daemon: Buffer.from(`#!/bin/sh\n# daemon for ${target}\n`),
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

/** A fake OSS server that actually recomputes and checks the V1 signature on every request
 * (rather than only trusting bytes), for two reasons: (1) it proves publish.ts's signing survives
 * a real HTTP round trip through Bun's fetch, not only the pure StringToSign unit test below, and
 * (2) its signature-mismatch response body mirrors a real OSS `SignatureDoesNotMatch` error,
 * which echoes `StringToSign`/`Signature`/`AccessKeyId` back to the caller - giving the
 * credential-leak test in this file something real to catch if publish.ts ever started printing
 * a response body. */
interface FakeOssOptions {
  credentials?: OssCredentials;
  failUploadKeys?: Set<string>;
  tamperReadbackKeys?: Set<string>;
}

interface FakeOss {
  baseUrl: string;
  calls: Array<{ method: string; key: string }>;
}

function startFakeOssServer(bucket: string, options: FakeOssOptions = {}): FakeOss {
  const credentials = options.credentials ?? CREDENTIALS;
  const store = new Map<string, Uint8Array>();
  const calls: Array<{ method: string; key: string }> = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const objectKey = url.pathname.slice(1);
      const method = request.method;
      calls.push({ method, key: objectKey });

      const date = request.headers.get("date") ?? "";
      const contentType = method === "PUT" ? (request.headers.get("content-type") ?? "") : "";
      const authorization = request.headers.get("authorization") ?? "";
      const expectedStringToSign = ossStringToSign({
        method: method as "PUT" | "GET",
        bucket,
        objectKey,
        date,
        contentType,
      });
      const expectedAuthorization = ossAuthorizationHeader(credentials, expectedStringToSign);
      if (authorization !== expectedAuthorization) {
        return new Response(
          `<Error><Code>SignatureDoesNotMatch</Code>` +
            `<AccessKeyId>${credentials.accessKeyId}</AccessKeyId>` +
            `<StringToSign>${expectedStringToSign}</StringToSign>` +
            `<AuthorizationProvided>${authorization}</AuthorizationProvided></Error>`,
          { status: 403, headers: { "x-oss-request-id": "fake-request-id-signature" } },
        );
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

      if (method === "GET") {
        const stored = store.get(objectKey);
        if (!stored) {
          return new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "x-oss-request-id": "fake-request-id-missing" },
          });
        }
        if (options.tamperReadbackKeys?.has(objectKey)) {
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
  return { baseUrl: `http://127.0.0.1:${server.port}`, calls };
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
/* 1. Signature correctness                                                                      */
/* ------------------------------------------------------------------------------------------- */

test("OSS V1 StringToSign has the documented shape", () => {
  const stringToSign = ossStringToSign({
    method: "PUT",
    bucket: "examplebucket",
    objectKey: "1.2.3/linux-x64/coforge-computer",
    date: "Tue, 01 Sep 2026 00:00:00 GMT",
    contentType: "application/octet-stream",
  });
  expect(stringToSign).toBe(
    "PUT\n\napplication/octet-stream\nTue, 01 Sep 2026 00:00:00 GMT\n" +
      "/examplebucket/1.2.3/linux-x64/coforge-computer",
  );
});

test("OSS V1 signature is stable for a fixed set of inputs (regression pin)", () => {
  // A self-constructed fixed vector, not lifted from Alibaba Cloud's docs verbatim: the expected
  // signature below was computed independently with Python's hmac/hashlib (sha1, base64) against
  // the exact StringToSign this test also asserts above - see the CR description for the
  // computation. Pinning it here catches a reworked implementation that silently changes the
  // string layout or hashing algorithm; a live OSS 403 would eventually catch the same bug, but
  // only in production.
  const stringToSign = ossStringToSign({
    method: "PUT",
    bucket: "examplebucket",
    objectKey: "1.2.3/linux-x64/coforge-computer",
    date: "Tue, 01 Sep 2026 00:00:00 GMT",
    contentType: "application/octet-stream",
  });
  const signature = ossSignature("testsecret", stringToSign);
  expect(signature).toBe("oZIPP7ZwCJvQBvYA7P1xWGITvfI=");
  expect(
    ossAuthorizationHeader({ accessKeyId: "testkey", accessKeySecret: "testsecret" }, stringToSign),
  ).toBe("OSS testkey:oZIPP7ZwCJvQBvYA7P1xWGITvfI=");
});

test("a GET StringToSign carries an empty Content-Type slot", () => {
  const stringToSign = ossStringToSign({
    method: "GET",
    bucket: "examplebucket",
    objectKey: "latest",
    date: "Tue, 01 Sep 2026 00:00:00 GMT",
    contentType: "",
  });
  expect(stringToSign).toBe("GET\n\n\nTue, 01 Sep 2026 00:00:00 GMT\n/examplebucket/latest");
});

/* ------------------------------------------------------------------------------------------- */
/* 2. Ordering: latest is written last, and only after every object is verified                 */
/* ------------------------------------------------------------------------------------------- */

test("a successful publish uploads every object, verifies every object, then writes and verifies latest - in that order", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-publish-ok", outputDirectory);
  const fake = startFakeOssServer(BUCKET);

  const result = await uploadReleaseTree(outputDirectory, tree, {
    target: { bucket: BUCKET, objectUrl: (key) => `${fake.baseUrl}/${key}` },
    credentials: CREDENTIALS,
  });

  expect(result.latestKey).toBe(LATEST_OBJECT_KEY);
  expect(result.uploaded).toEqual(tree.files);

  const expectedSequence = [
    ...tree.files.map((key) => ({ method: "PUT", key })),
    ...tree.files.map((key) => ({ method: "GET", key })),
    { method: "PUT", key: LATEST_OBJECT_KEY },
    { method: "GET", key: LATEST_OBJECT_KEY },
  ];
  expect(fake.calls).toEqual(expectedSequence);

  const latestPutIndex = fake.calls.findIndex(
    (call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY,
  );
  for (const call of fake.calls) {
    if (call.key === LATEST_OBJECT_KEY) continue;
    expect(fake.calls.indexOf(call)).toBeLessThan(latestPutIndex);
  }
});

test("a failed object upload never writes latest, and stops before uploading later objects", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-upload-fail", outputDirectory);
  // Fail the very first object in the sorted, deterministic file list.
  const failingKey = tree.files[0];
  if (!failingKey) throw new Error("fixture tree produced no files");
  const fake = startFakeOssServer(BUCKET, { failUploadKeys: new Set([failingKey]) });

  await expect(
    uploadReleaseTree(outputDirectory, tree, {
      target: { bucket: BUCKET, objectUrl: (key) => `${fake.baseUrl}/${key}` },
      credentials: CREDENTIALS,
    }),
  ).rejects.toThrow(/OSS upload failed: HTTP 500/);

  expect(fake.calls).toEqual([{ method: "PUT", key: failingKey }]);
  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(false);
});

/* ------------------------------------------------------------------------------------------- */
/* 3. Read-back verification                                                                     */
/* ------------------------------------------------------------------------------------------- */

test("a tampered read-back fails the publish and never writes latest", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-readback-fail", outputDirectory);
  const tamperedKey = tree.files.find((file) => file.endsWith("manifest.json"));
  if (!tamperedKey) throw new Error("fixture tree has no manifest.json");
  const fake = startFakeOssServer(BUCKET, { tamperReadbackKeys: new Set([tamperedKey]) });

  await expect(
    uploadReleaseTree(outputDirectory, tree, {
      target: { bucket: BUCKET, objectUrl: (key) => `${fake.baseUrl}/${key}` },
      credentials: CREDENTIALS,
    }),
  ).rejects.toThrow(/OSS read-back mismatch: .*manifest\.json/);

  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(false);
  // Every object was still uploaded before the mismatch was caught - only the read-back phase,
  // which runs after every upload, is where this fails.
  expect(
    fake.calls.filter((call) => call.method === "PUT" && call.key !== LATEST_OBJECT_KEY).length,
  ).toBe(tree.files.length);
});

/* ------------------------------------------------------------------------------------------- */
/* 4. Credential redaction                                                                       */
/* ------------------------------------------------------------------------------------------- */

test("a failed publish never prints the access key, secret, or an Authorization header value", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const version = "9.9.9-leak-check";
  await fixtureTree(version, outputDirectory);
  // Wrong secret: every request this run makes hits the fake server's signature-mismatch branch,
  // whose response body deliberately echoes the correct Authorization/StringToSign/AccessKeyId -
  // exactly the kind of OSS error body that must never reach stdout/stderr.
  const wrongSecret = "not-the-real-secret";
  const fake = startFakeOssServer(BUCKET, { credentials: CREDENTIALS });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));

  const previousEnv = {
    id: process.env.ALIYUN_OSS_ACCESS_KEY_ID,
    secret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET,
  };
  process.env.ALIYUN_OSS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
  process.env.ALIYUN_OSS_ACCESS_KEY_SECRET = wrongSecret;

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
        objectUrl: (key) => `${fake.baseUrl}/${key}`,
      },
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreEnvVar("ALIYUN_OSS_ACCESS_KEY_ID", previousEnv.id);
    restoreEnvVar("ALIYUN_OSS_ACCESS_KEY_SECRET", previousEnv.secret);
  }

  expect(exitCode).toBe(1);
  const combined = [...stdout, ...stderr].join("\n");
  expect(combined).not.toContain(wrongSecret);
  expect(combined).not.toContain(CREDENTIALS.accessKeySecret);
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
  expect(outcome.files).toContain("9.9.9-dry-run/linux-x64/coforge-computer");
  expect(outcome.latestKey).toBe(LATEST_OBJECT_KEY);
});

/* ------------------------------------------------------------------------------------------- */
/* CLI argument parsing                                                                          */
/* ------------------------------------------------------------------------------------------- */

test("parseTargets defaults to the four POSIX targets and validates unknown ones", () => {
  expect(parseTargets(undefined)).toEqual(DEFAULT_TARGETS);
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
