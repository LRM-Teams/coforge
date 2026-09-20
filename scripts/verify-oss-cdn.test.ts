import { describe, expect, test } from "bun:test";

import { runAcceptance, type AcceptanceInput } from "./verify-oss-cdn";

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function validInput(): AcceptanceInput {
  return {
    files_host: "files.coforge.cn",
    releases_host: "releases.coforge.cn",
    images_host: "images.coforge.cn",
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
    image: {
      origin_url:
        "https://coforge-images-test.oss-cn-example.aliyuncs.com/users/u/avatars/a/original",
      cdn_url: "https://images.coforge.cn/users/u/avatars/a/original?x-oss-process=style/avatar192",
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
      {
        name: "files-through-images",
        url: "https://images.coforge.cn/workspaces/w/attachments/a/original",
      },
      {
        name: "image-through-files",
        url: "https://files.coforge.cn/users/u/avatars/a/original?auth_key=valid",
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
      [input.image.origin_url, new Response("denied", { status: 403 })],
      [
        input.image.cdn_url,
        new Response("avatar", {
          status: 200,
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        }),
      ],
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
      if (
        [input.files_host, input.releases_host, input.images_host].includes(new URL(url).hostname)
      ) {
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

  test("fails when the unsigned image domain can reach a private attachment", async () => {
    const input = validInput();
    const attachmentThroughImages = input.rejected_urls.find(
      ({ name }) => name === "files-through-images",
    )!.url;

    const report = await runAcceptance(input, async (request) => {
      const url = String(request);
      if (url === attachmentThroughImages) return new Response("attachment", { status: 200 });
      if (url === input.image.cdn_url) {
        return new Response("avatar", {
          status: 200,
          headers: { "Cache-Control": "public, max-age=31536000, immutable" },
        });
      }
      if (url.startsWith("https://files.coforge.cn/workspaces")) {
        return new Response("attachment", {
          status: url.includes("auth_key") ? 200 : 403,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      return new Response("denied", { status: 403 });
    });

    expect(report.passed).toBe(false);
    expect(
      report.checks.find((check) => check.id === "route_rejected:files-through-images")?.passed,
    ).toBe(false);
  });

  test("refuses a run that mixes environments", async () => {
    const input = validInput();
    input.images_host = "images-staging.coforge.cn";
    input.image.cdn_url =
      "https://images-staging.coforge.cn/users/u/avatars/a/original?x-oss-process=style/avatar192";
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

  test("accepts a staging run when every domain is staging", async () => {
    const input = validInput();
    input.files_host = "files-staging.coforge.cn";
    input.releases_host = "releases-staging.coforge.cn";
    input.images_host = "images-staging.coforge.cn";
    for (const probe of [input.files, input.release, input.channels, input.image]) {
      probe.cdn_url = probe.cdn_url.replace(
        /(files|releases|images)\.coforge\.cn/,
        "$1-staging.coforge.cn",
      );
    }
    input.files.unsigned_cdn_url = input.files.unsigned_cdn_url.replace(
      "files.coforge.cn",
      "files-staging.coforge.cn",
    );
    input.rejected_urls = input.rejected_urls.map((probe) => ({
      ...probe,
      url: probe.url.replace(/(files|releases|images)\.coforge\.cn/, "$1-staging.coforge.cn"),
    }));

    const report = await runAcceptance(input, async () => new Response("denied", { status: 403 }));

    expect(report.checks.some((check) => check.id === "input_contract" && !check.passed)).toBe(
      false,
    );
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
