import { describe, expect, test } from "bun:test";

import { runAcceptance, type AcceptanceInput } from "./verify-oss-cdn";

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function validInput(): AcceptanceInput {
  return {
    cdn_host: "cdn.coforge.cn",
    files: {
      origin_url:
        "https://coforge-files-test.oss-cn-example.aliyuncs.com/workspaces/w/attachments/a/original",
      cdn_url: "https://cdn.coforge.cn/files/workspaces/w/attachments/a/original?auth_key=valid",
      unsigned_cdn_url: "https://cdn.coforge.cn/files/workspaces/w/attachments/a/original",
      expected_sha256: sha256("attachment"),
    },
    release: {
      origin_url:
        "https://coforge-releases-test.oss-cn-example.aliyuncs.com/release-sets/r/bundles/linux.tar.gz",
      cdn_url: "https://cdn.coforge.cn/releases/release-sets/r/bundles/linux.tar.gz",
      expected_sha256: sha256("release"),
    },
    channels: {
      origin_url: "https://coforge-releases-test.oss-cn-example.aliyuncs.com/channels.json",
      cdn_url: "https://cdn.coforge.cn/releases/channels.json",
      expected_sha256: sha256("channels"),
    },
    rejected_urls: [
      {
        name: "unmatched",
        url: "https://cdn.coforge.cn/not-routed/probe",
      },
      {
        name: "files-through-releases",
        url: "https://cdn.coforge.cn/releases/workspaces/w/attachments/a/original",
      },
      {
        name: "release-through-files",
        url: "https://cdn.coforge.cn/files/release-sets/r/bundles/linux.tar.gz?auth_key=valid",
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
      if (new URL(url).hostname === input.cdn_host) {
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

  test("fails closed when a required cross-prefix probe is missing", async () => {
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
