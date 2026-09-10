import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ci = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text());

test("the aggregate gate executes even after failure and rejects missing, skipped, or cancelled required jobs", () => {
  const gate = ci.jobs["ci-passed"];
  expect(gate?.if).toBe("always()");
  expect([...gate.needs].sort()).toEqual(
    Object.keys(ci.jobs)
      .filter((id) => id !== "ci-passed")
      .sort(),
  );
  const script = gate.steps[0].run;
  for (const result of ["success", "failure", "cancelled", "skipped", undefined]) {
    const needs = {
      changes: { result: "success", outputs: { jobs: '["changes","web"]' } },
      web: { result },
      computer: { result: "skipped" },
    };
    const run = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
      env: { ...Bun.env, NEEDS: JSON.stringify(needs) },
    });
    expect(run.exitCode === 0).toBe(result === "success");
  }
  for (const result of ["failure", "cancelled", "skipped"]) {
    const run = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
      env: { ...Bun.env, NEEDS: JSON.stringify({ changes: { result, outputs: {} } }) },
    });
    expect(run.exitCode).not.toBe(0);
  }
});

test("release callers select separate tracks and a no-op Web change cannot build an image", async () => {
  const deploy = Bun.YAML.parse(await Bun.file(".github/workflows/deploy-staging.yml").text());
  const release = Bun.YAML.parse(await Bun.file(".github/workflows/release-staging.yml").text());
  expect(deploy.jobs.gates.with.track).toBe("web");
  // A later docs-only push must not replace a pending Web-changing push.
  expect(deploy.concurrency.queue).toBe("max");
  expect(deploy.concurrency["cancel-in-progress"]).toBe(false);
  expect(deploy.jobs.image.if).toBe("needs.gates.outputs.deploy == 'true'");
  expect(deploy.jobs.image.needs).toBe("gates");
  expect(release.jobs.gates.with.track).toBe("local");
  expect(release.jobs.publish.needs).toBe("gates");
});

test("the workflow diffs PRs from their merge base and includes both sides of a rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-ci-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    await mkdir(join(dir, "scripts/ci"), { recursive: true });
    await Bun.write(join(dir, "scripts/ci/selection.ts"), Bun.file("scripts/ci/selection.ts"));
    await Bun.write(join(dir, "README.md"), "initial\n");
    git("init", "-b", "main");
    git("config", "user.name", "me-frankan");
    git("config", "user.email", "me.frankan@gmail.com");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-m", "initial");
    git("switch", "-c", "feature");
    await mkdir(join(dir, "apps/web"), { recursive: true });
    await Bun.write(join(dir, "apps/web/page.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-m", "web change");
    const head = git("rev-parse", "HEAD");
    git("switch", "main");
    await mkdir(join(dir, "packages/daemon"), { recursive: true });
    await Bun.write(join(dir, "packages/daemon/runtime.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-m", "unrelated main change");
    const base = git("rev-parse", "HEAD");
    const script = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === "select").run;
    const select = (event: string, before: string, after: string) => {
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
        cwd: dir,
        env: {
          ...Bun.env,
          TRACK: "changes",
          EVENT: event,
          BASE: before,
          HEAD: after,
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: join(dir, "output"),
        },
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    expect(select("pull_request", base, head)).toContain('checks=["web"]\n');
    git("switch", "feature");
    git("mv", "apps/web/page.ts", "docs.md");
    git("commit", "-m", "move web source to documentation");
    expect(select("push", head, git("rev-parse", "HEAD"))).toContain('checks=["web"]\n');
    expect(select("push", "0".repeat(40), head)).toContain(
      'contracts=["deploy","oss-cdn","release"]\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
