import { describe, expect, test } from "bun:test";

import {
  runAcceptance,
  verifyReleaseObject,
  type AcceptanceInput,
  type ContentProbe,
} from "./verify-oss-cdn";

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function validInput(): AcceptanceInput {
  return {
    files_host: "files.coforge.cn",
    releases_host: "releases.coforge.cn",
    files: {
      origin_url:
        "https://coforge-files-test.oss-cn-example.aliyuncs.com/workspaces/w/attachments/a/original",
      cdn_url: "https://files.coforge.cn/workspaces/w/attachments/a/original?auth_key=valid",
      unsigned_cdn_url: "https://files.coforge.cn/workspaces/w/attachments/a/original",
      expected_sha256: sha256("attachment"),
    },
    release: {
      origin_url:
        "https://coforge-releases-test.oss-cn-example.aliyuncs.com/release-sets/r/bundles/linux.tar.gz",
      cdn_url: "https://releases.coforge.cn/release-sets/r/bundles/linux.tar.gz",
      expected_sha256: sha256("release"),
    },
    channels: {
      origin_url: "https://coforge-releases-test.oss-cn-example.aliyuncs.com/channels.json",
      cdn_url: "https://releases.coforge.cn/channels.json",
      expected_sha256: sha256("channels"),
    },
    rejected_urls: [
      {
        name: "files-through-releases",
        url: "https://releases.coforge.cn/workspaces/w/attachments/a/original",
      },
      {
        name: "release-through-files",
        url: "https://files.coforge.cn/release-sets/r/bundles/linux.tar.gz?auth_key=valid",
      },
    ],
  };
}

describe("OSS/CDN acceptance", () => {
  test("accepts private origins, byte-identical CDN delivery, cache policy, and fail-closed routes", async () => {
    const input = validInput();
    const seenCookies: string[] = [];
    const responses = new Map<string, Response>([
      [input.files.origin_url, new Response("denied", { status: 403 })],
      [
        input.files.cdn_url,
        new Response("attachment", {
          status: 200,
          headers: { "Cache-Control": "private, no-store" },
        }),
      ],
      [input.files.unsigned_cdn_url, new Response("denied", { status: 403 })],
      [input.release.origin_url, new Response("denied", { status: 403 })],
      [
        input.release.cdn_url,
        new Response("release", {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        }),
      ],
      [input.channels.origin_url, new Response("denied", { status: 403 })],
      [
        input.channels.cdn_url,
        new Response("channels", {
          status: 200,
          headers: { "Cache-Control": "no-cache, must-revalidate" },
        }),
      ],
      ...input.rejected_urls.map(
        ({ url }) => [url, new Response("denied", { status: 403 })] as const,
      ),
    ]);

    const report = await runAcceptance(input, async (request, init) => {
      const url = String(request);
      if ([input.files_host, input.releases_host].includes(new URL(url).hostname)) {
        seenCookies.push(new Headers(init?.headers).get("cookie") ?? "");
      }
      const response = responses.get(url);
      if (!response) throw new Error("unexpected test URL");
      return response.clone();
    });

    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(seenCookies.length).toBeGreaterThan(0);
    expect(
      seenCookies.every((cookie) => cookie === "coforge_acceptance_probe=must-not-authorize"),
    ).toBe(true);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("aliyuncs.com");
    expect(serialized).not.toContain("auth_key");
    expect(serialized).not.toContain("coforge-files-test");
  });

  test("fails closed when a required cross-domain probe is missing", async () => {
    const input = validInput();
    input.rejected_urls = input.rejected_urls.filter(
      ({ name }) => name !== "release-through-files",
    );
    let requestCount = 0;

    const report = await runAcceptance(input, async () => {
      requestCount += 1;
      return new Response("should not run", { status: 500 });
    });

    expect(report.passed).toBe(false);
    expect(report.checks).toEqual([
      {
        id: "input_contract",
        passed: false,
        detail: "acceptance input is incomplete or outside the approved scope",
      },
    ]);
    expect(requestCount).toBe(0);
  });

  test("turns network failures into a sanitized failure report", async () => {
    const input = validInput();
    const report = await runAcceptance(input, async (request) => {
      throw new Error(`request failed for ${String(request)}`);
    });

    expect(report.passed).toBe(false);
    expect(report.checks.at(-1)).toEqual({
      id: "probe_execution",
      passed: false,
      detail: "a probe could not complete; inspect operator-side diagnostics",
    });
    expect(JSON.stringify(report)).not.toContain("auth_key");
    expect(JSON.stringify(report)).not.toContain("aliyuncs.com");
  });

  test("CLI reads stdin and returns only a sanitized failing report", async () => {
    const input = validInput();
    input.rejected_urls = [];
    const child = Bun.spawn([process.execPath, "scripts/verify-oss-cdn.ts", "--input", "-"], {
      cwd: import.meta.dir + "/..",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      passed: false,
      checks: [
        {
          id: "input_contract",
          passed: false,
          detail: "acceptance input is incomplete or outside the approved scope",
        },
      ],
    });
    expect(stdout).not.toContain("auth_key");
    expect(stdout).not.toContain("aliyuncs.com");
  });
});

describe("release object verification", () => {
  const probe: ContentProbe = {
    origin_url: "http://origin.fixture.test/releases/app.tar.gz?secret=origin-signature",
    cdn_url: "http://cdn.fixture.test/releases/app.tar.gz?token=cdn-credential",
    expected_sha256: sha256("release bytes"),
  };

  test("accepts an origin-private, byte-identical CDN object without forwarding credentials", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const report = await verifyReleaseObject(probe, async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return url === probe.origin_url
        ? new Response("denied", { status: 403 })
        : new Response("release bytes", { status: 200 });
    });

    expect(report.passed).toBe(true);
    expect(requests.map(({ url }) => url)).toEqual([probe.origin_url, probe.cdn_url]);
    for (const { init } of requests) {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
    }
  });

  test.each([
    ["readable", new Response("release bytes", { status: 200 })],
    ["missing", new Response("missing", { status: 404 })],
    ["redirecting", new Response(null, { status: 302, headers: { Location: "/login" } })],
  ])("rejects a %s origin", async (_name, originResponse) => {
    const report = await verifyReleaseObject(probe, async (input) =>
      String(input) === probe.origin_url
        ? originResponse.clone()
        : new Response("release bytes", { status: 200 }),
    );

    expect(report.passed).toBe(false);
    expect(
      report.checks.find(({ id }) => id === "release_origin_rejects_unsigned_get")?.passed,
    ).toBe(false);
  });

  test.each([
    ["stale", new Response("old release", { status: 200 })],
    ["missing", new Response("missing", { status: 404 })],
    ["redirecting", new Response(null, { status: 302, headers: { Location: "/other" } })],
    ["setting a cookie", new Response("release bytes", { headers: { "Set-Cookie": "sid=x" } })],
    [
      "leaking the origin host",
      new Response("release bytes", {
        headers: { Via: "origin.fixture.test" },
      }),
    ],
  ])("rejects a CDN response that is %s", async (_name, cdnResponse) => {
    const report = await verifyReleaseObject(probe, async (input) =>
      String(input) === probe.origin_url
        ? new Response("denied", { status: 403 })
        : cdnResponse.clone(),
    );

    expect(report.passed).toBe(false);
    expect(report.checks.find(({ id }) => id === "release_cdn_object_matches")?.passed).toBe(false);
  });

  test("turns network errors into a sanitized failure report", async () => {
    const report = await verifyReleaseObject(probe, async (input) => {
      if (String(input) === probe.origin_url) return new Response("denied", { status: 403 });
      throw new Error(`failed with Authorization: bearer secret at ${String(input)}`);
    });

    expect(report.passed).toBe(false);
    expect(report.checks.at(-1)).toEqual({
      id: "release_object_probe_execution",
      passed: false,
      detail: "the release object probe could not complete; inspect operator-side diagnostics",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("cdn.fixture.test");
    expect(serialized).not.toContain("cdn-credential");
    expect(serialized).not.toContain("release bytes");
    expect(serialized).not.toContain("bearer secret");
  });
});
