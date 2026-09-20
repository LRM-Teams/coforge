import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createECDH, createHash } from "node:crypto";
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

test("optional GitHub deployment credentials reach Compose without entering stdout", async () => {
  const script = await readFile(new URL("./remote-deploy.sh", import.meta.url), "utf8");
  const functions = script.slice(
    script.indexOf("load_compose_secrets()"),
    script.indexOf("# Fail closed on a mutable"),
  );
  const directory = await mkdtemp(join(tmpdir(), "coforge-github-deploy-"));
  try {
    for (const name of [
      "authing_app_id",
      "authing_app_secret",
      "coforge_session_secret",
      "coforge_agent_credential_encryption_key",
      "coforge_web_push_public_key",
      "coforge_web_push_private_key",
      "coforge_file_delivery_key",
    ])
      await writeFile(join(directory, name), "fixture");
    for (const configured of [false, true]) {
      if (configured) {
        await writeFile(join(directory, "coforge_github_client_secret"), "github-fixture");
        await writeFile(join(directory, "coforge_github_credential_encryption_key"), "key-fixture");
        await writeFile(join(directory, "coforge_github_app_slug"), "fixture-app");
        await writeFile(join(directory, "coforge_github_app_bot_user_id"), "328977087");
        await writeFile(join(directory, "coforge_github_webhook_secret"), "hook-fixture");
      }
      const child = Bun.spawn(
        [
          "bash",
          "-euc",
          `${functions}
        secrets_dir="$1"
        COMPOSE_ARGS=()
        docker() {
          test "\${COFORGE_GITHUB_CLIENT_SECRET-unset}" = "$2"
          test "\${COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY-unset}" = "$3"
          test "\${COFORGE_GITHUB_APP_SLUG-unset}" = "$4"
          test "\${COFORGE_GITHUB_APP_BOT_USER_ID-unset}" = "$5"
          test "\${COFORGE_GITHUB_WEBHOOK_SECRET-unset}" = "$6"
        }
        load_compose_secrets
        compose "$2" "$3" "$4" "$5" "$6"
      `,
          "test",
          directory,
          configured ? "github-fixture" : "",
          configured ? "key-fixture" : "",
          configured ? "fixture-app" : "",
          configured ? "328977087" : "",
          configured ? "hook-fixture" : "",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
      await mkdir(join(root, "centrifugo"));
      await writeFile(join(root, "centrifugo/config.yaml"), "client:\n  allowed_origins: []\n");
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
      expect(envFile).toContain("COFORGE_CENTRIFUGO_CONFIG_SHA256=");
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("candidate failure diagnostics", () => {
  for (const mode of ["available", "unavailable", "oversized"]) {
    test(`diagnostics precede rollback without leaking logs (${mode})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "coforge-deploy-failure-"));
      try {
        await mkdir(join(root, "bin"));
        await mkdir(join(root, "secrets"));
        await mkdir(join(root, "centrifugo"));
        await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
        await Bun.write(join(root, "compose.yml"), "services: {}\n");
        for (const name of [
          "authing_app_id",
          "authing_app_secret",
          "coforge_session_secret",
          "coforge_agent_credential_encryption_key",
          "coforge_web_push_public_key",
          "coforge_web_push_private_key",
          "coforge_file_delivery_key",
          "postgres_password",
          "redis_password",
          "centrifugo_http_api_key",
          "centrifugo_proxy_secret",
          "worker_jwt_key_id",
          "worker_jwt_private_jwk",
        ])
          await Bun.write(join(root, "secrets", name), "fixture-private-value");
        const previous = `coforge/web@sha256:${"b".repeat(64)}`;
        const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
        await Bun.write(join(root, "state.env"), state);
        // The shim must not depend on a host `timeout`: macOS ships none (GNU coreutils is not
        // guaranteed), so `Bun.which` returns undefined. When there is no real timeout, run the
        // command directly, dropping timeout's own options and duration — remote-deploy.sh always
        // invokes it as `<options> <duration> <command>`. The fixture commands are instant, so no
        // deadline is needed; the call recording is unaffected.
        const realTimeout = Bun.which("timeout");
        await writeFile(
          join(root, "bin/timeout"),
          `#!/bin/bash
echo "timeout $*" >> "$FIXTURE_ROOT/calls"
${
  realTimeout
    ? `exec ${JSON.stringify(realTimeout)} "$@"`
    : `while [[ "$1" == -* ]]; do shift; done
shift
exec "$@"`
}
`,
          { mode: 0o700 },
        );
        await writeFile(
          join(root, "bin/docker"),
          `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  case "$1" in
    up) if [[ ! -f "$FIXTURE_ROOT/candidate-failed" ]]; then touch "$FIXTURE_ROOT/candidate-failed"; exit 1; fi ;;
    ps) echo abc123 ;;
  esac
elif [[ "$1" = ps || "$1" = logs ]]; then
  if [[ "$DIAGNOSTICS_MODE" = unavailable ]]; then echo fixture-private-value >&2; exit 1; fi
  if [[ "$1" = ps ]]; then echo abc123; else
    if [[ "$DIAGNOSTICS_MODE" = oversized ]]; then printf '%20000s' ''; fi
    echo 'TypeError: createSsrRpc is not a function fixture-private-value'
    echo 'https://user:fixture-private-value@example.test/?token=unknown-private-value'
  fi
elif [[ "$1" = inspect ]]; then
  if [[ "$*" = *RestartCount* ]]; then echo 'running 0 3 unhealthy'; else echo healthy; fi
fi
`,
          { mode: 0o700 },
        );
        await writeFile(
          join(root, "bin/curl"),
          `#!/bin/bash
if [[ "$*" = *http_code* ]]; then echo 500; fi
`,
          { mode: 0o700 },
        );
        const proc = Bun.spawn(
          [
            "bash",
            new URL("./remote-deploy.sh", import.meta.url).pathname,
            "--image",
            registryImage,
            "--compose-file",
            join(root, "compose.yml"),
            "--secrets-dir",
            join(root, "secrets"),
            "--state-file",
            join(root, "state.env"),
            "--web-health-url",
            "http://127.0.0.1/health",
            "--public-health-url",
            "https://example.test/health",
          ],
          {
            env: {
              ...Bun.env,
              PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
              FIXTURE_ROOT: root,
              DIAGNOSTICS_MODE: mode,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(0);
        expect(parseRemoteOutputs(stdout).outcome).toBe("rolled_back");
        expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
        expect(stderr).toContain("candidate diagnostics");
        expect(stderr.indexOf("candidate diagnostics")).toBeLessThan(stderr.indexOf("rolled back"));
        expect(stdout + stderr).not.toContain("fixture-private-value");
        expect(stdout + stderr).not.toContain("unknown-private-value");
        expect(stderr).toContain("candidate loopback health HTTP status: 500");
        if (mode !== "unavailable") {
          expect(stderr).toContain(
            mode === "oversized"
              ? "startup_signature=unclassified_or_unavailable"
              : "startup_signature=createSsrRpc",
          );
          expect(stderr).toContain("candidate state/exit/restarts/health: running 0 3 unhealthy");
        }
        const calls = await Bun.file(join(root, "calls")).text();
        expect(calls).toContain(
          "timeout --kill-after=1s 5s docker ps --filter label=com.docker.compose.project=coforge-staging",
        );
        if (mode !== "unavailable")
          expect(calls).toContain(
            "timeout --kill-after=1s 5s docker logs --tail 80 --since 5m abc123",
          );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

// Shared by the Centrifugo config-guard and snapshot/rollback tests below.
const requiredSecretNames = [
  "authing_app_id",
  "authing_app_secret",
  "coforge_session_secret",
  "coforge_agent_credential_encryption_key",
  "coforge_web_push_public_key",
  "coforge_web_push_private_key",
  "coforge_file_delivery_key",
  "postgres_password",
  "redis_password",
  "centrifugo_http_api_key",
  "centrifugo_proxy_secret",
  "worker_jwt_key_id",
  "worker_jwt_private_jwk",
];

describe("Centrifugo configuration guard and release snapshot", () => {
  test("a Centrifugo configuration the pinned image rejects stops the deployment before anything is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-centrifugo-reject-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  if [[ "$1" = run && "$*" == *checkconfig* ]]; then
    exit 1
  fi
fi
exit 0
`,
        { mode: 0o700 },
      );
      const proc = Bun.spawn(
        [
          "bash",
          new URL("./remote-deploy.sh", import.meta.url).pathname,
          "--image",
          registryImage,
          "--compose-file",
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const outputs = parseRemoteOutputs(stdout);
      expect(outputs.outcome).toBe("failed");
      expect(outputs.healthResult).toBe("failed: Centrifugo configuration validation failed");
      expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
      const calls = await Bun.file(join(root, "calls")).text();
      expect(calls).not.toMatch(/ up -d/);
      expect(calls).toContain("pull --quiet centrifugo");
      expect(calls).not.toContain("pull --quiet web");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a Centrifugo image the host cannot pull is reported as a pull failure, not a configuration failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-centrifugo-pull-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  if [[ "$1" = pull && "$*" == *centrifugo* ]]; then
    exit 1
  fi
fi
exit 0
`,
        { mode: 0o700 },
      );
      const proc = Bun.spawn(
        [
          "bash",
          new URL("./remote-deploy.sh", import.meta.url).pathname,
          "--image",
          registryImage,
          "--compose-file",
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const outputs = parseRemoteOutputs(stdout);
      expect(outputs.outcome).toBe("failed");
      expect(outputs.healthResult).toBe("failed: Centrifugo image pull failed");
      expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
      const calls = await Bun.file(join(root, "calls")).text();
      expect(calls).not.toContain("checkconfig");
      expect(calls).not.toMatch(/ up -d/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rollback restores the last healthy release configuration together with the image", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-rollback-snapshot-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await mkdir(join(root, "last-healthy/centrifugo"), { recursive: true });
      const marker = "client: {}\n# last healthy\n";
      await Bun.write(join(root, "last-healthy/centrifugo/config.yaml"), marker);
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n# stale candidate\n");
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(
        join(root, "bin/timeout"),
        `#!/bin/bash
echo "timeout $*" >> "$FIXTURE_ROOT/calls"
exec ${JSON.stringify(Bun.which("timeout"))} "$@"
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  case "$1" in
    up)
      if [[ ! -f "$FIXTURE_ROOT/up-failed-once" ]]; then
        touch "$FIXTURE_ROOT/up-failed-once"
        exit 1
      fi
      ;;
    ps) echo "container-$3" ;;
  esac
  exit 0
elif [[ "$1" = ps || "$1" = logs ]]; then
  exit 0
elif [[ "$1" = inspect ]]; then
  if [[ "$*" = *RestartCount* ]]; then
    echo 'running 0 1 unhealthy'
  else
    echo healthy
  fi
fi
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(root, "bin/curl"),
        `#!/bin/bash
if [[ "$*" = *http_code* ]]; then echo 500; fi
exit 0
`,
        { mode: 0o700 },
      );
      const proc = Bun.spawn(
        [
          "bash",
          new URL("./remote-deploy.sh", import.meta.url).pathname,
          "--image",
          registryImage,
          "--compose-file",
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(parseRemoteOutputs(stdout).outcome).toBe("rolled_back");
      expect(await Bun.file(join(root, "centrifugo/config.yaml")).text()).toBe(marker);
      const markerSha256 = createHash("sha256").update(marker).digest("hex");
      const env = await Bun.file(join(root, ".env")).text();
      expect(env).toContain(`COFORGE_CENTRIFUGO_CONFIG_SHA256=${markerSha256}`);
      expect(stderr).toContain("restored the last healthy release configuration");
      const calls = await Bun.file(join(root, "calls")).text();
      const upCalls = calls.split("\n").filter((line) => line.includes("up -d --wait"));
      expect(upCalls).toHaveLength(2);
      expect(upCalls[1]?.trim().endsWith(" web")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a healthy deployment records the shipped configuration as the last healthy release", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-healthy-snapshot-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      const shipped = "client: {}\n# shipped candidate\n";
      await Bun.write(join(root, "centrifugo/config.yaml"), shipped);
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  case "$1" in
    ps) echo "container-$3" ;;
  esac
  exit 0
elif [[ "$1" = inspect ]]; then
  if [[ "$*" == *Config.Image* ]]; then
    echo "$IMAGE_REF"
  elif [[ "$*" == *Health.Status* ]]; then
    echo healthy
  fi
  exit 0
elif [[ "$1" = image ]]; then
  exit 0
fi
exit 0
`,
        { mode: 0o700 },
      );
      await writeFile(join(root, "bin/curl"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
      const proc = Bun.spawn(
        [
          "bash",
          new URL("./remote-deploy.sh", import.meta.url).pathname,
          "--image",
          registryImage,
          "--compose-file",
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
            FIXTURE_ROOT: root,
            IMAGE_REF: registryImage,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(parseRemoteOutputs(stdout).outcome).toBe("healthy");
      expect(await Bun.file(join(root, "last-healthy/centrifugo/config.yaml")).text()).toBe(
        shipped,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("check-centrifugo-config.sh", () => {
  test("checks both configuration files against the digest-pinned image the staging Compose file ships", async () => {
    const script = await Bun.file(new URL("./check-centrifugo-config.sh", import.meta.url)).text();
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();

    // Mirrors the script's own extraction: the exact image line under the
    // centrifugo: service, and it must be digest-pinned - this test never
    // runs docker, only proves the shape the script depends on holds today.
    const centrifugoStart = compose.indexOf("\n  centrifugo:\n");
    const redisStart = compose.indexOf("\n  redis:\n");
    expect(centrifugoStart).toBeGreaterThanOrEqual(0);
    expect(redisStart).toBeGreaterThan(centrifugoStart);
    const centrifugoBlock = compose.slice(centrifugoStart, redisStart);
    const imageLine = centrifugoBlock.match(/^ {4}image: (\S+)$/m);
    expect(imageLine).not.toBeNull();
    expect(imageLine?.[1]).toMatch(/@sha256:[0-9a-f]{64}$/);

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("infra/centrifugo/config.yaml");
    expect(script).toContain("infra/staging/centrifugo/config.yaml");
    expect(script).toContain("checkconfig -c /config.yaml");
    expect(script).toContain("CENTRIFUGO_VAR_RPC_PROXY_SECRET");
    expect(script).toContain("is not pinned to a digest");
  });

  test("is wired into check:deploy alongside the other deploy scripts", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    expect(packageJson).toContain("check-centrifugo-config.sh");
    expect(packageJson).toContain("remote-deploy.sh");
  });
});

describe("staging Web Push key validation", () => {
  const keyPair = () => {
    const ecdh = createECDH("prime256v1");
    const publicKey = ecdh.generateKeys().toString("base64url");
    return { publicKey, privateKey: ecdh.getPrivateKey().toString("base64url") };
  };

  test("rejects a mismatched pair before any remote deployment step", async () => {
    const first = keyPair();
    const second = keyPair();
    const validator = Bun.spawn(["bun", "scripts/deploy/validate-web-push-keys.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...Bun.env,
        COFORGE_WEB_PUSH_PUBLIC_KEY: second.publicKey,
        COFORGE_WEB_PUSH_PRIVATE_KEY: first.privateKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await validator.exited).not.toBe(0);

    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow.indexOf("Validate Web Push key pair")).toBeLessThan(
      workflow.indexOf("Prepare the SSH identity"),
    );
  });

  test("accepts a matching pair", async () => {
    const pair = keyPair();
    const validator = Bun.spawn(["bun", "scripts/deploy/validate-web-push-keys.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...Bun.env,
        COFORGE_WEB_PUSH_PUBLIC_KEY: pair.publicKey,
        COFORGE_WEB_PUSH_PRIVATE_KEY: pair.privateKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await validator.exited).toBe(0);
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
    expect(workflow).not.toContain("OSS_ACCESS_KEY");
    expect(workflow).toContain("infra/staging/secrets");
    expect(workflow).toContain('trap \'rm -rf -- "$tar_dir" "$payload"\' EXIT');
    expect(workflow).toContain(String.raw`chmod 700 \"\$secrets_dir\"`);
    expect(workflow).not.toMatch(/echo "\$AUTHING_APP_SECRET"/);
    expect(workflow).not.toMatch(/echo "\$COFORGE_SESSION_SECRET"/);
  });
});

describe("staging user file persistence", () => {
  test("user file bytes are stored in the staging OSS bucket, not a local volume", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    // The block ends at migrate, not centrifugo: migrate sits between them, so a
    // wider slice would also pass if the config were attached to the wrong service.
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    expect(migrateStart).toBeGreaterThan(webStart);
    const webBlock = compose.slice(webStart, migrateStart);

    // Without the OSS adapter selected, the app falls back to a container-local
    // directory, and every deployment silently discards what users uploaded.
    expect(webBlock).toContain("COFORGE_FILE_STORAGE: oss");
    expect(webBlock).toContain("COFORGE_OSS_BUCKET: coforge-files-staging");
    expect(webBlock).toContain("COFORGE_OSS_REGION: cn-beijing");
    expect(webBlock).toContain("ALIBABA_CLOUD_ECS_METADATA: coforge-staging-web");
    expect(webBlock).not.toContain("COFORGE_FILE_STORAGE_DIR");
    expect(webBlock).not.toContain("ACCESS_KEY");
  });

  test("chat images are delivered from the private CDN domain, with the signing key mounted as a secret", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const webBlock = compose.slice(webStart, migrateStart);

    expect(webBlock).toContain("COFORGE_FILE_DELIVERY_URL: https://files-staging.coforge.cn");
    // Profile images ride a second bucket and an unsigned domain (ADR 0052). The two settings
    // are asserted together because the Web process refuses to boot with only one of them.
    expect(webBlock).toContain("COFORGE_IMAGE_OSS_BUCKET: coforge-images-staging");
    expect(webBlock).toContain("COFORGE_IMAGE_DELIVERY_URL: https://images-staging.coforge.cn");
    expect(webBlock).toContain(
      "COFORGE_FILE_DELIVERY_KEY_FILE: /run/secrets/coforge_file_delivery_key",
    );
    expect(webBlock).toContain("source: coforge_file_delivery_key");
    // The Web container runs as uid 1000 under a rootless daemon; only an `environment:`
    // sourced secret is written with the declared uid/mode. A `file:` source is unreadable.
    expect(compose).toContain(
      "coforge_file_delivery_key:\n    environment: COFORGE_FILE_DELIVERY_KEY",
    );
    const deploy = await Bun.file(new URL("./remote-deploy.sh", import.meta.url)).text();
    expect(deploy).toContain(
      'COFORGE_FILE_DELIVERY_KEY="$(cat "$secrets_dir/coforge_file_delivery_key")"',
    );

    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("secrets.COFORGE_FILE_DELIVERY_KEY");
    expect(workflow).toContain("coforge_file_delivery_key");
    expect(workflow).not.toMatch(/echo "\$COFORGE_FILE_DELIVERY_KEY"/);
  });

  test("staging serves install.sh pointing at the staging feed, not the production one", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const webBlock = compose.slice(webStart, migrateStart);

    // Unset, and /computer/install.sh answers 503 instead of installing anything; set to the
    // production feed, and `curl https://staging.coforge.cn/... | sh` would install the
    // production build on a staging machine. Both are silent from CI's point of view.
    expect(webBlock).toContain("COFORGE_RELEASE_FEED_URL: https://releases-staging.coforge.cn");
  });

  test("the image owns the mount point so the volume is not created root-owned", async () => {
    const dockerfile = await Bun.file(new URL("../../apps/web/Dockerfile", import.meta.url)).text();
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

    const mountPoint = runtimeStage.indexOf("mkdir -p /data/attachments");
    const dropPrivileges = runtimeStage.indexOf("USER bun");
    expect(mountPoint).toBeGreaterThanOrEqual(0);
    expect(runtimeStage).toContain("chown -R bun:bun /data");
    expect(mountPoint).toBeLessThan(dropPrivileges);
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
    expect(channelConfig).toContain("    - name: agent\n");
    expect(channelConfig).toContain("    - name: chat\n");
    expect(rpcConfig).toContain("    - name: daemon\n");
  }
});

describe("staging environment configuration", () => {
  test("non-secret deploy targets are variables, not write-only secrets", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();

    // A secret cannot be read back, so a hostname stored as one is invisible when it is
    // wrong and has to be re-entered to change. Only values that must stay unreadable
    // belong in secrets.
    expect(workflow).toContain("${{ vars.DEPLOY_SSH_HOST }}");
    expect(workflow).toContain("${{ vars.DEPLOY_SSH_USER }}");
    expect(workflow).not.toContain("secrets.DEPLOY_SSH_HOST }}");
    expect(workflow).not.toContain("secrets.DEPLOY_SSH_USER }}");

    // The private key, the host fingerprint and the OTLP endpoint stay secrets: the first
    // two are credentials, and the endpoint embeds an access token.
    expect(workflow).toContain("${{ secrets.DEPLOY_SSH_KEY }}");
    expect(workflow).toContain("${{ secrets.DEPLOY_SSH_HOST_KEY }}");
    expect(workflow).toContain("${{ secrets.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }}");
  });
});

test("GitHub workflows pin external actions to full commit SHAs", async () => {
  for (const path of [
    "../../.github/workflows/ci.yml",
    "../../.github/workflows/deploy-staging.yml",
    "../../.github/workflows/release-staging.yml",
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

describe("GitHub validation workflow contract", () => {
  test("manual publication refuses refs other than main before running gates", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/release-staging.yml", import.meta.url),
    ).text();
    const gates = workflow.match(/^  gates:\n[\s\S]*?(?=^  [\w-]+:\n)/m)?.[0];
    expect(gates).toContain("if: github.ref == 'refs/heads/main'");
  });

  test("CI serves pull requests and reusable callers without also running on main pushes", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("  pull_request:\n");
    expect(workflow).toContain("  workflow_call:\n");
    expect(workflow).not.toContain("  push:\n");
  });

  test("staging deployment and manual release use the shared CI gates", async () => {
    for (const path of [
      "../../.github/workflows/deploy-staging.yml",
      "../../.github/workflows/release-staging.yml",
    ]) {
      const workflow = await Bun.file(new URL(path, import.meta.url)).text();
      const gates = workflow.match(/^  gates:\n[\s\S]*?(?=^  [\w-]+:\n)/m)?.[0];

      expect(gates).toBeDefined();
      expect(gates).toContain("uses: ./.github/workflows/ci.yml");
      expect(gates).not.toContain("runs-on:");
      expect(gates).not.toContain("mise run");
    }
  });

  test("CI covers SDK, Agent, and CLI tests, checks, and buildable libraries", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
    ).text();

    // The selector's behavioral tests cover which packages enter this matrix.
    // Each selected library must still execute its full package-owned gates.
    for (const command of ["test", "check", "build"]) {
      expect(workflow).toContain(`bun run --cwd packages/\${{ matrix.package }} ${command}`);
    }
    expect(workflow).toContain("if: matrix.package != 'coforge-sdk'");
    expect(workflow).toContain("bun run --cwd packages/coforge-sdk generate");
  });
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
