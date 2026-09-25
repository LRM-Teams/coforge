import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Members keeps its scrolling inside the directory list: the document itself never grows past the
 * viewport, with or without an Agent's profile open beside the list.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user in a
 * Workspace with at least four Agents (seed-dev). The viewport is short enough that the list
 * overflows its scroll box, which the test checks first. A screenshot is written under
 * `.amp/e2e/members-page-overflow/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/members-page-overflow");

test("Members never scrolls the document, with or without an Agent's profile open", async () => {
  const session = `members-page-overflow-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "30000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  const card = `a[aria-label^="Open "][aria-label$="profile"]`;
  const cards = `document.querySelectorAll('${card}').length >= 4`;
  /** The list overflows its own scroll box (so the check means something); the document does not. */
  async function expectOnlyTheListScrolls() {
    const overflow = JSON.parse(
      await browser(
        "eval",
        `(() => {
          const list = document.querySelector('[role="tabpanel"]');
          return {
            document: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            list: list ? list.scrollHeight - list.clientHeight : -1,
          };
        })()`,
      ),
    ) as { document: number; list: number };
    expect(overflow.list).toBeGreaterThan(0);
    expect(overflow.document).toBeLessThanOrEqual(0);
  }

  try {
    await browser("set", "viewport", "1280", "480");
    await browser("open", `${origin}/en/agents?memberType=agent&owner=all`);
    await browser("wait", "--fn", cards);
    await expectOnlyTheListScrolls();

    await browser("eval", `document.querySelector('${card}').click()`);
    await browser(
      "wait",
      "--fn",
      `${cards} && document.querySelector('#profile[data-panel]') !== null`,
    );
    await expectOnlyTheListScrolls();

    await mkdir(artifacts, { recursive: true });
    await browser("screenshot", join(artifacts, "members-with-profile.png"));
  } finally {
    await browser("close").catch(() => undefined);
  }
}, 120_000);
