import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
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
  // The newest pending push replaces older pending ones; a running deployment is never cancelled.
  expect(deploy.concurrency.queue).toBeUndefined();
  expect(deploy.concurrency["cancel-in-progress"]).toBe(false);
  // Finding the base reads this repository's workflow runs.
  expect(ci.jobs.changes.permissions).toEqual({ contents: "read", actions: "read" });
  expect(deploy.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
  expect(release.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
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
      'contracts=["cdn-certs","deploy","oss-cdn","release"]\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a push diffs from the last successful run of its workflow, so superseded pushes stay in scope", async () => {
  const steps = ci.jobs.changes.steps as {
    id?: string;
    if?: string;
    env?: Record<string, string>;
    run: string;
  }[];
  const base = steps.find((step) => step.id === "base")!;
  expect(base.if).toBe("github.event_name == 'push'");
  expect(base.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    REPOSITORY: "${{ github.repository }}",
    RUN_ID: "${{ github.run_id }}",
    BRANCH: "${{ github.ref_name }}",
  });
  expect(steps.find((step) => step.id === "select")!.env!.BASE).toBe(
    "${{ github.event.pull_request.base.sha || steps.base.outputs.sha }}",
  );
  const dir = await mkdtemp(join(tmpdir(), "coforge-ci-base-"));
  try {
    const calls = join(dir, "calls");
    await Bun.write(
      join(dir, "gh"),
      `#!/bin/bash
printf '%s\\n' "$2" >> "${calls}"
case "$2" in
  repos/LRM-Teams/coforge/actions/runs/42) body='{"id":42,"workflow_id":7}' ;;
  repos/LRM-Teams/coforge/actions/workflows/7/runs*) body="$RUNS" ;;
  *) exit 1 ;;
esac
# gh applies --jq and prints strings raw.
[ "$3" = --jq ] && printf '%s' "$body" | jq -r "$4"
`,
    );
    await chmod(join(dir, "gh"), 0o755);
    const findBase = (lastSuccess: string) => {
      const output = join(dir, `output-${lastSuccess || "none"}`);
      const runs = lastSuccess ? [{ id: 41, head_sha: lastSuccess }] : [];
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", base.run], {
        env: {
          ...Bun.env,
          PATH: `${dir}:${Bun.env.PATH}`,
          RUNS: JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
          REPOSITORY: "LRM-Teams/coforge",
          RUN_ID: "42",
          BRANCH: "main",
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.exitCode).toBe(0);
      return Bun.file(output).text();
    };
    expect(await findBase("a".repeat(40))).toBe(`sha=${"a".repeat(40)}\n`);
    expect(await Bun.file(calls).text()).toContain(
      "repos/LRM-Teams/coforge/actions/workflows/7/runs?branch=main&event=push&status=success&per_page=1\n",
    );
    // No successful run yet: an empty base makes the select step cover everything.
    expect(await findBase("")).toBe("sha=\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
