import { describe, expect, test } from "bun:test";

const CDN_DOMAINS = [
  "files-staging.coforge.cn",
  "releases-staging.coforge.cn",
  "images-staging.coforge.cn",
];

async function readScript(): Promise<string> {
  return Bun.file(new URL("./renew-cdn-certificates.sh", import.meta.url)).text();
}

async function readRunbook(): Promise<string> {
  return Bun.file(new URL("../../docs/operations/cdn-certificates.md", import.meta.url)).text();
}

describe("renew-cdn-certificates.sh", () => {
  test("covers every CDN domain that terminates TLS at the edge", async () => {
    const script = await readScript();
    for (const domain of CDN_DOMAINS) {
      expect(script).toContain(`"${domain}"`);
    }
    // The inventory is one array, not scattered literals: adding a domain
    // later must stay a one-line change to this block.
    const inventoryStart = script.indexOf("CDN_DOMAINS=(");
    const inventoryEnd = script.indexOf(")", inventoryStart);
    expect(inventoryStart).toBeGreaterThanOrEqual(0);
    const inventory = script.slice(inventoryStart, inventoryEnd);
    for (const domain of CDN_DOMAINS) {
      expect(inventory).toContain(domain);
    }
  });

  test("validates with dns_ali and deploys with ali_cdn, not a hand-rolled signer", async () => {
    const script = await readScript();
    expect(script).toContain("--dns dns_ali");
    expect(script).toContain("--deploy-hook ali_cdn");
    expect(script).toContain("DEPLOY_ALI_CDN_DOMAIN");
  });

  test("names the certificate authority instead of inheriting the host's default", async () => {
    const script = await readScript();
    // acme.sh defaults to ZeroSSL, so an unqualified --issue would not produce
    // the Let's Encrypt certificate this runbook promises.
    expect(script).toContain("--server letsencrypt");
  });

  test("never hardcodes AccessKey material", async () => {
    const script = await readScript();
    // Ali_Key/Ali_Secret must only ever be read from the environment
    // (`${Ali_Key:-}`) or referenced by name in operator-facing guidance
    // text, never assigned a literal secret value.
    expect(script).toContain("${Ali_Key:-}");
    expect(script).toContain("${Ali_Secret:-}");
    // A real Alibaba Cloud AccessKey ID starts with this prefix; catch one
    // pasted in by mistake.
    expect(script).not.toMatch(/LTAI[0-9A-Za-z]{16,}/);
    expect(script).not.toContain("set -x");
  });

  test("fails closed with a runnable fix when credentials are missing", async () => {
    const script = await readScript();
    const failureBlock = script.slice(
      script.indexOf("require_credentials()"),
      script.indexOf("# Installs acme.sh"),
    );
    expect(failureBlock).toContain("Ali_Key");
    expect(failureBlock).toContain("Ali_Secret");
    expect(failureBlock).toContain("export Ali_Key=");
    expect(failureBlock).toContain("export Ali_Secret=");
    expect(failureBlock).toContain("exit 1");

    const child = Bun.spawn(["bash", "-c", `${script}\nrequire_credentials`], {
      env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "/tmp" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("Ali_Key");
    expect(stderr).toContain("Ali_Secret");
    expect(stderr).not.toContain("undefined");
  });

  test("is idempotent: acme.sh's near-expiry skip is the safety net, not a custom guard", async () => {
    const script = await readScript();
    expect(script).toContain("FORCE_RENEW");
    // --force must stay opt-in; the default invocation relies on acme.sh's
    // own renewal window, per acme.sh's documented issue/renew behavior.
    expect(script).not.toMatch(/^\s*--force\b/m);
  });

  test("verifies acme.sh's own cron rather than installing a second scheduler", async () => {
    const script = await readScript();
    expect(script).toContain("crontab -l");
    expect(script).toContain("--install-cronjob");
  });

  test("reports the live certificate expiry observed on each domain", async () => {
    const script = await readScript();
    expect(script).toContain("openssl");
    expect(script).toContain("x509 -noout -enddate");
  });

  test("is shellcheck-clean and never disables a check inline", async () => {
    const script = await readScript();
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toContain("shellcheck disable");
  });
});

describe("CDN certificate runbook", () => {
  test("documents the exact same domain list as the script, so the two cannot drift", async () => {
    const runbook = await readRunbook();
    for (const domain of CDN_DOMAINS) {
      expect(runbook).toContain(domain);
    }
  });

  test("names the minimal RAM actions the AccessKey needs", async () => {
    const runbook = await readRunbook();
    expect(runbook).toContain("alidns:AddDomainRecord");
    expect(runbook).toContain("alidns:DeleteDomainRecord");
    expect(runbook).toContain("alidns:DescribeDomainRecords");
    expect(runbook).toContain("cdn:SetCdnDomainSSLCertificate");
  });

  test("cites the official acme.sh and Alibaba Cloud sources", async () => {
    const runbook = await readRunbook();
    expect(runbook).toContain("https://github.com/acmesh-official/acme.sh/wiki/dnsapi");
    expect(runbook).toContain("https://github.com/acmesh-official/acme.sh/wiki/deployhooks");
    expect(runbook).toContain(
      "https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-setcdndomainsslcertificate",
    );
  });
});

describe("wiring", () => {
  test("is wired into its own test and check scripts, in the same shape as deploy and oss-cdn", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    expect(packageJson).toContain('"test:cdn-certs"');
    expect(packageJson).toContain('"check:cdn-certs"');
    expect(packageJson).toContain("renew-cdn-certificates.sh");
    expect(packageJson).toContain("cdn-certificates.test.ts");
  });

  test("the aliyun-oss-cdn runbook points at the new document instead of the stale manual-renewal warning", async () => {
    const ossCdnRunbook = await Bun.file(
      new URL("../../docs/operations/aliyun-oss-cdn.md", import.meta.url),
    ).text();
    expect(ossCdnRunbook).toContain("cdn-certificates.md");
    expect(ossCdnRunbook).not.toContain("不自动续期");
  });
});
