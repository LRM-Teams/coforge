import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Run after run-computer-setup.sh, against its real installed Computer. No
// application imports, database seeding, injected Provider, or runtime starts.
test("installed Computer creates an Agent through Web and persists its real reply", async () => {
  const origin = Bun.env.COFORGE_E2E_WEB_URL;
  const registrationPath = Bun.env.COFORGE_E2E_REGISTRATION;
  if (!origin || !registrationPath || !Bun.env.OPENROUTER_API_KEY)
    throw new Error("Native E2E requires Web URL, registration path, and OpenRouter key");
  if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("Native browser E2E only targets the disposable local Web service");
  const registration = await Bun.file(registrationPath).json();
  expect(registration.workspace_slug).toBe(Bun.env.COFORGE_E2E_WORKSPACE_SLUG);
  expect(typeof registration.computer_id).toBe("string");
  const browserPath = Bun.which("agent-browser");
  if (!browserPath) throw new Error("agent-browser is required");
  const name = `native-${Date.now()}`;
  const session = `native-${process.pid}`;
  const attachmentDir = await mkdtemp(resolve(tmpdir(), "native-attachment-"));
  let failed = false;
  async function browser(...args: string[]) {
    const child = Bun.spawn(
      [browserPath!, "--session", session, "--ignore-https-errors", ...args],
      {
        env: { ...Bun.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "15000" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Native browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function click(role: string, label: string) {
    await browser("find", "role", role, "click", "--name", label, "--exact");
    if (role === "option")
      await browser("wait", "--fn", "!document.querySelector('[role=listbox]')");
  }
  try {
    console.log("native_browser:computer_online");
    await browser("open", `${origin}/en/computers/${registration.computer_id}`);
    await browser("set", "viewport", "1280", "720", "2");
    await browser("wait", "--text", "Online");
    const inventory = await browser("snapshot", "-i");
    if (inventory.includes('"Publish Pi"')) {
      await click("button", "Publish Pi");
    }
    await browser(
      "wait",
      "--fn",
      `Array.from(document.querySelectorAll('button')).some(e => e.getAttribute('aria-label') === 'Make Pi private')`,
    );

    console.log("native_browser:create_agent");
    await click("link", "Members");
    await browser(
      "wait",
      "--fn",
      "Array.from(document.querySelectorAll('button')).some(e => e.textContent.trim() === 'New agent')",
    );
    await click("button", "New agent");
    await browser("find", "role", "textbox", "fill", "--name", "Name *", "--exact", name);
    await browser("find", "role", "button", "click", "--name", "Computer *");
    await browser("click", `[role="option"][data-key="${registration.computer_id}"]`);
    await browser("wait", "--fn", "!document.querySelector('[role=listbox]')");
    await click("button", "CoForge Runtime provider");
    await click("option", "Pi");
    await click("button", "Use provider default Model provider");
    await click("option", "openrouter");
    await click("button", "Use provider default Model");
    await click("option", "openrouter / DeepSeek: DeepSeek V4.1 Flash");
    await click("button", "Create agent");
    await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
    await browser(
      "wait",
      "--fn",
      `Array.from(document.querySelectorAll('a')).some(e => e.textContent.trim() === ${JSON.stringify(name)})`,
    );
    const agentPath: string = JSON.parse(
      await browser(
        "eval",
        `Array.from(document.querySelectorAll('a')).find(e => e.textContent.trim() === ${JSON.stringify(name)}).getAttribute('href')`,
      ),
    );
    const agentId = new URL(agentPath, origin).pathname.split("/").at(-1)!;
    await browser("click", `a[href="/en/messages/${agentId}"]`);
    await browser("wait", "--url", `**/messages/${agentId}`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('main h1')?.textContent.trim() === ${JSON.stringify(name)}`,
    );
    expect(
      JSON.parse(
        await browser(
          "eval",
          'fetch(location.href).then(r=>r.text()).then(html=>new DOMParser().parseFromString(html,"text/html").querySelector("textarea").disabled)',
        ),
      ),
    ).toBe(true);
    await browser("wait", "--fn", "document.querySelector('textarea')?.disabled === false");

    const reply = `NATIVE_E2E_${Date.now()}`;
    const replyPresent = `Array.from(document.querySelectorAll('[data-message-id]')).some(row => row.querySelector('[data-message="other"]') && row.textContent.includes(${JSON.stringify(name)}) && Array.from(row.querySelectorAll('div')).some(e => e.textContent.trim() === ${JSON.stringify(reply)}))`;
    // A request containing the same words must never satisfy the Agent-reply assertion.
    expect(JSON.parse(await browser("eval", replyPresent))).toBe(false);
    await browser(
      "find",
      "role",
      "textbox",
      "fill",
      "--name",
      "Message",
      "--exact",
      `Reply with exactly: ${reply}`,
    );
    expect((await browser("get", "value", "textarea")).trim()).toBe(`Reply with exactly: ${reply}`);
    await browser(
      "wait",
      "--fn",
      "Array.from(document.querySelectorAll('button')).some(e => (e.getAttribute('aria-label') || e.textContent.trim()) === 'Send' && !e.disabled)",
    );
    await click("button", "Send");
    await browser(
      "wait",
      "--fn",
      `Array.from(document.querySelectorAll('[data-message-id]')).some(e => e.textContent.includes(${JSON.stringify(`Reply with exactly: ${reply}`)}))`,
    );
    console.log("native_browser:await_agent_reply");
    await browser("wait", "--fn", replyPresent, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", replyPresent))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", replyPresent, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", replyPresent))).toBe(true);
    console.log("native_browser:send_attachment");
    const attachmentName = "read-me.txt";
    const attachmentContent = `ATTACHMENT_${crypto.randomUUID()}`;
    const attachmentPath = resolve(attachmentDir, attachmentName);
    await Bun.write(attachmentPath, attachmentContent);
    await browser("wait", "--fn", "document.querySelector('textarea')?.disabled === false");
    await browser("upload", 'input[type="file"]', attachmentPath);
    await browser(
      "find",
      "role",
      "textbox",
      "fill",
      "--name",
      "Message",
      "--exact",
      "Read the attached text file and reply with exactly its contents.",
    );
    await click("button", "Send");
    const attachmentSelector = `[data-message-id] a[href^="/api/attachments/"]`;
    await browser("wait", attachmentSelector);
    // The expected contents and local source path are never supplied to the Agent.
    // Remove the source after upload; reading the original local file cannot pass.
    await rm(attachmentDir, { recursive: true, force: true });
    const attachmentReplyPresent = `Array.from(document.querySelectorAll('[data-message-id]')).some(row => row.querySelector('[data-message="other"]') && row.textContent.includes(${JSON.stringify(name)}) && Array.from(row.querySelectorAll('div')).some(e => e.textContent.trim() === ${JSON.stringify(attachmentContent)}))`;
    await browser("wait", "--fn", attachmentReplyPresent, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", attachmentReplyPresent))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", attachmentReplyPresent, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", replyPresent))).toBe(true);
    expect(JSON.parse(await browser("eval", attachmentReplyPresent))).toBe(true);
    await browser("wait", attachmentSelector);
    expect(
      JSON.parse(
        await browser(
          "eval",
          `document.querySelector(${JSON.stringify(attachmentSelector)}).textContent.includes(${JSON.stringify(attachmentName)})`,
        ),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        await browser(
          "eval",
          `fetch(document.querySelector(${JSON.stringify(attachmentSelector)}).href).then(async r => ({status:r.status, body:await r.text()}))`,
        ),
      ),
    ).toEqual({ status: 200, body: attachmentContent });
    await mkdir(resolve(import.meta.dir, "../../.amp/in/artifacts"), { recursive: true });
    await browser(
      "screenshot",
      resolve(import.meta.dir, "../../.amp/in/artifacts/native-browser-reply.png"),
    );
    console.log("native_browser:create_task");
    const taskTitle = `TASK_${crypto.randomUUID()}: After this task is assigned to you, create a text file named task-result.txt containing task received, then submit this task for review. Do not start before assignment.`;
    await browser("click", 'nav[aria-label="Chat / Tasks"] button:last-child');
    await click("button", "Create task");
    await browser("find", "role", "textbox", "fill", "--name", "Title", "--exact", taskTitle);
    await browser("click", '[role="dialog"] button[type="submit"]');
    await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
    await browser("click", 'nav[aria-label="Chat / Tasks"] button:last-child');
    await browser("wait", "article");
    expect((await browser("get", "text", "article")).includes(taskTitle)).toBe(true);
    expect((await browser("get", "text", "article")).includes("Unassigned")).toBe(true);
    await browser("find", "role", "button", "click", "--name", "More actions for task");
    await click("menuitem", "View and edit");
    await browser(
      "find",
      "role",
      "textbox",
      "fill",
      "--name",
      "Assignee handle",
      "--exact",
      `@${name}`,
    );
    await click("button", "Assign");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('article')?.textContent.includes(${JSON.stringify(name)})`,
    );
    await browser("find", "last", '[role="dialog"] button', "click");
    await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
    console.log("native_browser:await_task_review");
    const taskInReview = `Array.from(document.querySelectorAll('section[aria-label="In review"] article')).some(e => e.textContent.includes(${JSON.stringify(taskTitle)}) && e.textContent.includes(${JSON.stringify(name)}))`;
    await browser("wait", "--fn", taskInReview, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", taskInReview))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", taskInReview, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", taskInReview))).toBe(true);
    await browser(
      "screenshot",
      resolve(import.meta.dir, "../../.amp/in/artifacts/native-browser-task.png"),
    );
    console.log(
      JSON.stringify({
        event: "native_browser:passed",
        agentId,
        name,
        replyPersisted: true,
        attachmentReplyPersisted: true,
        taskReviewPersisted: true,
      }),
    );
  } catch (error) {
    failed = true;
    try {
      await Bun.write(
        resolve(import.meta.dir, "../../.amp/e2e/native-browser-failure.txt"),
        await browser("snapshot"),
      );
    } catch (diagnosticError) {
      console.error("native_browser:diagnostic_failed", diagnosticError);
    }
    throw error;
  } finally {
    await rm(attachmentDir, { recursive: true, force: true });
    await browser("close").catch((cleanupError) => {
      if (!failed) throw cleanupError;
      console.error("native_browser:cleanup_failed", cleanupError);
    });
  }
}, 660_000);
