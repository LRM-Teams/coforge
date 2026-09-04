import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import {
  InvalidImageError,
  InvalidStateError,
  type DeploymentRecord,
  parseImmutableImage,
  parseRemoteOutputs,
  parseState,
  renderAuditRecord,
  renderState,
} from "./deployment";

const authingRuntimeSecretKeys = [
  "AUTHING_APP_ID",
  "AUTHING_APP_SECRET",
  "COFORGE_SESSION_SECRET",
] as const;

const digest = `sha256:${"a".repeat(64)}`;
const registryImage = `registry.cn-hangzhou.aliyuncs.com/coforge/web@${digest}`;
const bareImage = `coforge/web@${digest}`;

describe("parseImmutableImage", () => {
  test("accepts a full digest-pinned reference", () => {
    const image = parseImmutableImage(registryImage);
    expect(image.digest).toBe(digest);
    expect(image.reference).toBe(registryImage);
  });

  test("accepts a reference without a registry host", () => {
    expect(parseImmutableImage(bareImage).digest).toBe(digest);
  });

  test("rejects a mutable latest tag", () => {
    expect(() => parseImmutableImage("registry.example/coforge/web:latest")).toThrow(
      InvalidImageError,
    );
  });

  test("rejects a branch alias tag", () => {
    expect(() => parseImmutableImage("coforge/web:main")).toThrow(InvalidImageError);
  });

  test("rejects a reference without a digest", () => {
    expect(() => parseImmutableImage("coforge/web")).toThrow(InvalidImageError);
  });

  test("rejects an unknown digest algorithm", () => {
    expect(() => parseImmutableImage(`coforge/web@md5:${"a".repeat(32)}`)).toThrow(
      InvalidImageError,
    );
  });

  test("rejects a truncated digest", () => {
    expect(() => parseImmutableImage(`coforge/web@${"sha256:"}${"a".repeat(63)}`)).toThrow(
      InvalidImageError,
    );
  });

  test("rejects an uppercase digest", () => {
    expect(() => parseImmutableImage(`coforge/web@sha256:${"A".repeat(64)}`)).toThrow(
      InvalidImageError,
    );
  });
});

describe("parseState", () => {
  test("parses an empty environment as bootstrap state", () => {
    const state = parseState("CURRENT_WEB_IMAGE=\nPREVIOUS_WEB_IMAGE=\n");
    expect(state.currentWebImage).toBeNull();
    expect(state.previousWebImage).toBeNull();
  });

  test("parses a current image with an empty previous", () => {
    const state = parseState(`CURRENT_WEB_IMAGE=${registryImage}\nPREVIOUS_WEB_IMAGE=\n`);
    expect(state.currentWebImage).toBe(registryImage);
    expect(state.previousWebImage).toBeNull();
  });

  test("rejects a mutable image in state", () => {
    expect(() => parseState("CURRENT_WEB_IMAGE=coforge/web:latest\nPREVIOUS_WEB_IMAGE=\n")).toThrow(
      InvalidImageError,
    );
  });

  test("rejects a malformed line", () => {
    expect(() => parseState("garbage line\n")).toThrow(InvalidStateError);
  });

  test("rejects an unknown key", () => {
    expect(() => parseState("CURRENT_IMAGE=\nPREVIOUS_WEB_IMAGE=\n")).toThrow(InvalidStateError);
  });

  test("rejects a duplicate key", () => {
    expect(() => parseState(`CURRENT_WEB_IMAGE=${registryImage}\nCURRENT_WEB_IMAGE=\n`)).toThrow(
      InvalidStateError,
    );
  });

  test("rejects a missing key", () => {
    expect(() => parseState("CURRENT_WEB_IMAGE=\n")).toThrow(InvalidStateError);
  });

  test("round-trips through renderState", () => {
    const state = parseState(`CURRENT_WEB_IMAGE=${registryImage}\nPREVIOUS_WEB_IMAGE=${bareImage}`);
    expect(parseState(renderState(state))).toEqual(state);
  });
});

describe("renderAuditRecord", () => {
  const startedAt = "2026-08-31T02:00:00.000Z";
  const completedAt = "2026-08-31T02:05:00.000Z";
  const baseRecord: DeploymentRecord = {
    deployment_id: "d4d5e6f7-0000-4000-8000-000000000001",
    source_commit: "493a0c5",
    track: "cloud",
    artifact_identity: registryImage,
    environment: "staging",
    workflow_run: "https://github.com/LRM-Teams/coforge/actions/runs/33350525525",
    previous_digest: null,
    rollback_target: null,
    health_result: "healthy",
    approval: null,
    executor: "agent",
    started_at: startedAt,
    completed_at: completedAt,
    outcome: "healthy",
  };

  test("renders exactly one JSON line", () => {
    const line = renderAuditRecord(baseRecord);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual(baseRecord);
  });

  test("renders a fixed key order", () => {
    const keys = Object.keys(JSON.parse(renderAuditRecord(baseRecord)));
    expect(keys).toEqual([
      "deployment_id",
      "source_commit",
      "track",
      "artifact_identity",
      "environment",
      "workflow_run",
      "previous_digest",
      "rollback_target",
      "health_result",
      "approval",
      "executor",
      "started_at",
      "completed_at",
      "outcome",
    ]);
  });

  test("refuses a record that carries an approval", () => {
    expect(() => renderAuditRecord({ ...baseRecord, approval: "frank" })).toThrow();
  });

  test("refuses an unknown outcome", () => {
    expect(() => renderAuditRecord({ ...baseRecord, outcome: "unknown" as never })).toThrow();
  });

  test("refuses a mutable artifact identity", () => {
    expect(() =>
      renderAuditRecord({ ...baseRecord, artifact_identity: "coforge/web:main" }),
    ).toThrow(InvalidImageError);
  });
});

describe("remote-deploy.sh compose invocation shape", () => {
  test("passes secrets only to Compose and places global arguments before its subcommand", async () => {
    const script = await Bun.file(new URL("./remote-deploy.sh", import.meta.url)).text();
    const directInvocations = script.split("\n").filter((line) => line.includes("docker compose"));
    expect(directInvocations).toEqual(['\t\tdocker compose "${COMPOSE_ARGS[@]}" "$@"']);
    expect(script).not.toContain("export AUTHING_APP_ID");
  });

  test("keeps the migration container output off the key=value report", async () => {
    const script = await Bun.file(new URL("./remote-deploy.sh", import.meta.url)).text();
    const runIndex = script.split("\n").findIndex((line) => line.includes("compose run"));
    expect(runIndex).toBeGreaterThanOrEqual(0);
    const runBlock = script.slice(script.indexOf("compose run")).split("then")[0];
    // The script itself arrives on stdin over SSH; the container must not
    // inherit it (it would consume the rest of the deploy script), and its
    // output must not corrupt the key=value report on stdout.
    expect(runBlock).toContain("</dev/null");
    expect(runBlock).toContain("1>&2");
  });

  test("keeps Authing values out of compose .env and replaces it with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-write-deploy-env-"));
    try {
      const secretsDir = join(root, "secrets");
      await mkdir(secretsDir, { mode: 0o700 });
      await writeFile(join(root, "docker-compose.yml"), "name: coforge-staging\n");
      const files: Record<string, string> = {
        postgres_password: "pg-pass",
        redis_password: "redis-pass",
        centrifugo_http_api_key: "centrifugo-api",
        centrifugo_proxy_secret: "centrifugo-proxy",
        worker_jwt_key_id: "coforge-staging",
        worker_jwt_private_jwk: '{"kty":"OKP"}',
        authing_app_id: "staging-app-id",
        authing_app_secret: "staging-app-secret",
        authing_issuer: "https://coforge.authing.cn/oidc",
        authing_redirect_uri: "https://staging.coforge.cn/auth/callback",
        coforge_session_secret: "staging-session-secret-at-least-32-chars",
      };
      for (const [name, value] of Object.entries(files)) {
        await writeFile(join(secretsDir, name), value, { mode: 0o600 });
      }
      const envPath = join(root, ".env");
      await writeFile(envPath, "STALE=value\n", { mode: 0o644 });
      await chmod(envPath, 0o644);

      const script = await Bun.file(new URL("./remote-deploy.sh", import.meta.url)).text();
      const start = script.indexOf("write_deploy_env() {");
      const end = script.indexOf("\n}\n", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const fn = script.slice(start, end + 2);

      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          [
            "set -euo pipefail",
            `compose_file=${JSON.stringify(join(root, "docker-compose.yml"))}`,
            `secrets_dir=${JSON.stringify(secretsDir)}`,
            fn,
            `write_deploy_env ${JSON.stringify(registryImage)}`,
          ].join("\n"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode, stderr).toBe(0);

      const envFile = await readFile(join(root, ".env"), "utf8");
      expect(envFile).not.toContain("AUTHING_");
      expect(envFile).not.toContain("COFORGE_SESSION_SECRET");
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("staging Authing runtime injection", () => {
  test("compose mounts Authing values only into web and fixes the trusted endpoints", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const centrifugoStart = compose.indexOf("\n  centrifugo:\n");
    expect(webStart).toBeGreaterThanOrEqual(0);
    expect(centrifugoStart).toBeGreaterThan(webStart);
    const webBlock = compose.slice(webStart, centrifugoStart);
    for (const key of authingRuntimeSecretKeys) {
      expect(webBlock).toContain(`${key}_FILE: /run/secrets/${key.toLowerCase()}`);
      expect(webBlock).not.toContain(`${key}: \${`);
    }
    expect(webBlock).toContain("AUTHING_ISSUER: https://coforge.authing.cn/oidc");
    expect(webBlock).toContain("AUTHING_REDIRECT_URI: https://staging.coforge.cn/auth/callback");
    expect(webBlock).toContain("source: authing_app_id");
    expect(webBlock).toContain("source: authing_app_secret");
    expect(webBlock).toContain("source: coforge_session_secret");
    expect(webBlock).toContain(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE: /run/secrets/otel_traces_endpoint",
    );
    expect(webBlock).toContain("source: otel_traces_endpoint");

    const migrationStart = compose.indexOf("\n  migrate:\n");
    expect(migrationStart).toBeGreaterThan(webStart);
    const migrationBlock = compose.slice(migrationStart, centrifugoStart);
    expect(migrationBlock).not.toContain("AUTHING_");
    expect(migrationBlock).not.toContain("COFORGE_SESSION_SECRET");
  });

  test("deploy workflow copies Authing GitHub Environment values into the secrets directory", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("vars.AUTHING_APP_ID");
    expect(workflow).toContain("secrets.AUTHING_APP_SECRET");
    expect(workflow).toContain("secrets.COFORGE_SESSION_SECRET");
    expect(workflow).toContain("secrets.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    expect(workflow).toContain("otel_traces_endpoint");
    expect(workflow).toContain("infra/staging/secrets");
    expect(workflow).toContain('trap \'rm -rf -- "$tar_dir" "$payload"\' EXIT');
    expect(workflow).toContain(String.raw`chmod 700 \"\$secrets_dir\"`);
    expect(workflow).not.toMatch(/echo "\$AUTHING_APP_SECRET"/);
    expect(workflow).not.toMatch(/echo "\$COFORGE_SESSION_SECRET"/);
  });
});

test("authenticates and declares the Computer-directed Daemon channel in Centrifugo", async () => {
  for (const [path, connectEndpoint] of [
    [
      "../../infra/centrifugo/config.yaml",
      "endpoint: http://host.docker.internal:8789/api/internal/centrifugo-connect",
    ],
    [
      "../../infra/staging/centrifugo/config.yaml",
      "endpoint: http://web:3000/api/internal/centrifugo-connect",
    ],
  ]) {
    const config = await Bun.file(new URL(path, import.meta.url)).text();
    const channelConfig = config.slice(config.indexOf("\nchannel:\n"), config.indexOf("\nrpc:\n"));
    const rpcConfig = config.slice(config.indexOf("\nrpc:\n"));
    expect(config).toContain(connectEndpoint);
    expect(channelConfig).toContain("    - name: daemon\n");
    expect(rpcConfig).toContain("    - name: daemon\n");
  }
});

test("GitHub workflows pin external actions to full commit SHAs", async () => {
  for (const path of [
    "../../.github/workflows/ci.yml",
    "../../.github/workflows/deploy-staging.yml",
  ]) {
    const workflow = await Bun.file(new URL(path, import.meta.url)).text();
    const references = workflow
      .split("\n")
      .map((line) => line.match(/^\s*-?\s*uses:\s*([^#\s]+)/)?.[1])
      .filter((reference) => reference && !reference.startsWith("./"));

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  }
});

describe("parseRemoteOutputs", () => {
  test("parses a healthy report", () => {
    const outputs = parseRemoteOutputs(
      ["previous_web_image=", "health_result=healthy", "outcome=healthy", "rollback_target="].join(
        "\n",
      ),
    );
    expect(outputs.outcome).toBe("healthy");
    expect(outputs.previousWebImage).toBeNull();
    expect(outputs.rollbackTarget).toBeNull();
  });

  test("parses a rollback report", () => {
    const outputs = parseRemoteOutputs(
      [
        `previous_web_image=${registryImage}`,
        "health_result=failed: candidate unhealthy",
        "outcome=rolled_back",
        `rollback_target=${registryImage}`,
      ].join("\n"),
    );
    expect(outputs.outcome).toBe("rolled_back");
    expect(outputs.previousWebImage).toBe(registryImage);
    expect(outputs.rollbackTarget).toBe(registryImage);
  });

  test("rejects a malformed line", () => {
    expect(() => parseRemoteOutputs("garbage\n")).toThrow();
  });

  test("rejects an unexpected key", () => {
    expect(() => parseRemoteOutputs("secret=x\noutcome=healthy\n")).toThrow();
  });

  test("rejects a missing key", () => {
    expect(() => parseRemoteOutputs("outcome=healthy\n")).toThrow();
  });
});
