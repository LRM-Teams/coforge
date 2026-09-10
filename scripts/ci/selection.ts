const allChecks = [
  "agent",
  "cli",
  "computer",
  "daemon",
  "deploy",
  "macos-lifecycle",
  "oss-cdn",
  "protocol",
  "release",
  "web",
  "windows-installer",
  "windows-release",
];

export function selectChecks(paths: string[], track: "changes" | "web" | "local") {
  if (track === "local") {
    return allChecks.filter((check) => !["deploy", "oss-cdn", "web"].includes(check));
  }
  const checks = new Set<string>();
  for (const path of paths) {
    // Only known documentation locations are exempt; source assets (including
    // Markdown prompts) inside application directories may affect runtime behavior.
    if (/^(docs\/|[^/]+\.md$)/.test(path) || /\/(AGENTS|README)\.md$/.test(path)) continue;
    let affected: string[];
    if (/^(apps|packages)\/[^/]+\/package\.json$/.test(path)) {
      // All workspace manifests participate in the shared frozen install and Docker build.
      affected = allChecks;
    } else if (path === "scripts/release/install.ps1") {
      affected = ["release", "web", "windows-installer"];
    } else if (path === "scripts/release/install.sh") {
      affected = ["release", "web"];
    } else if (path.startsWith("apps/web/")) {
      affected = ["web"];
    } else if (path.startsWith("packages/computer/")) {
      affected = ["computer", "macos-lifecycle", "windows-release"];
    } else if (/^packages\/(agent|cli|daemon)\//.test(path)) {
      affected = ["computer", "daemon", "macos-lifecycle", "windows-release"];
      if (path.startsWith("packages/agent/")) affected.push("agent", "web");
      if (path.startsWith("packages/cli/")) affected.push("cli");
    } else if (path.startsWith("scripts/release/")) {
      affected = ["computer", "daemon", "macos-lifecycle", "release", "windows-release"];
    } else if (path.startsWith("scripts/deploy/") || path.startsWith("infra/")) {
      affected = ["deploy", "web"];
    } else if (/^scripts\/verify-oss-cdn[.]/.test(path)) {
      affected = ["oss-cdn"];
    } else {
      // Protocol, toolchain, CI, lockfiles, and unclassified new paths get full coverage.
      affected = allChecks;
    }
    for (const check of affected) checks.add(check);
  }
  if (track === "web") return checks.has("web") ? ["deploy", "protocol", "web"] : [];
  return [...checks].sort();
}

if (import.meta.main) {
  const track = Bun.argv[2];
  if (track !== "changes" && track !== "web" && track !== "local") {
    throw new Error("Expected changes, web, or local track");
  }
  const paths = (await Bun.stdin.text()).split("\0").filter(Boolean);
  const checks = selectChecks(paths, track);
  const libraries = checks.filter((check) => ["protocol", "agent", "cli"].includes(check));
  const contracts = checks.filter((check) => ["deploy", "release", "oss-cdn"].includes(check));
  const jobs = [
    "changes",
    ...new Set(
      checks.map((check) =>
        libraries.includes(check)
          ? "libraries"
          : contracts.includes(check)
            ? "infrastructure-contracts"
            : check,
      ),
    ),
  ];
  for (const [key, value] of Object.entries({ checks, libraries, contracts, jobs })) {
    console.log(`${key}=${JSON.stringify(value)}`);
  }
  console.log(`deploy=${track === "web" && checks.includes("web")}`);
}
