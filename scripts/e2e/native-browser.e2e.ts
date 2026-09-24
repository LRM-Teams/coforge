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
  let computerStopped = false;
  async function controlComputer(action: "stop" | "start") {
    const executable = Bun.which("coforge-computer");
    if (!executable) throw new Error("Installed Computer is required");
    const child = Bun.spawn([executable, action], { stdout: "pipe", stderr: "pipe" });
    const [, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Computer ${action} failed: ${stderr}`);
  }
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
    await browser("find", "role", "textbox", "fill", "--name", "Task 1", "--exact", taskTitle);
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
    console.log("native_browser:approve_task");
    const taskDone = `Array.from(document.querySelectorAll('section[aria-label="Done"] article')).some(e => e.textContent.includes(${JSON.stringify(taskTitle)}) && e.textContent.includes(${JSON.stringify(name)}))`;
    expect(JSON.parse(await browser("eval", taskDone))).toBe(false);
    await browser("find", "role", "button", "click", "--name", "Change status");
    await click("option", "Done");
    await browser(
      "wait",
      "--fn",
      `(${taskDone}) && !document.querySelector('article')?.closest('[aria-busy="true"]')`,
    );
    expect(JSON.parse(await browser("eval", taskDone))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", taskDone);
    expect(JSON.parse(await browser("eval", taskDone))).toBe(true);
    expect(JSON.parse(await browser("eval", taskInReview))).toBe(false);
    await browser(
      "screenshot",
      resolve(import.meta.dir, "../../.amp/in/artifacts/native-browser-task-done.png"),
    );
    console.log("native_browser:agent_create_task");
    const agentTaskTitle = `FOLLOWUP_${crypto.randomUUID()}`;
    await click("button", "Chat");
    await browser("wait", "--fn", "document.querySelector('textarea')?.disabled === false");
    await browser(
      "find",
      "role",
      "textbox",
      "fill",
      "--name",
      "Message",
      "--exact",
      `Plan one new follow-up subtask: create a new task titled exactly ${agentTaskTitle}, assign it to yourself, then execute it by writing agent-created.txt containing agent created task. Submit that subtask for review. Keep the new subtask separate from this planning request.`,
    );
    await click("button", "Send");
    const agentTaskMessage = `Array.from(document.querySelectorAll('[data-message-id]')).some(row => row.querySelector('[data-message="other"]') && row.textContent.includes(${JSON.stringify(name)}) && Array.from(row.querySelectorAll('div')).some(e => e.textContent.trim() === ${JSON.stringify(agentTaskTitle)}))`;
    // A converted human request or a card alone does not prove Agent-originated creation.
    await browser("wait", "--fn", agentTaskMessage, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", agentTaskMessage))).toBe(true);
    const agentTaskMessageId: string = JSON.parse(
      await browser(
        "eval",
        `Array.from(document.querySelectorAll('[data-message-id]')).find(row => row.querySelector('[data-message="other"]') && Array.from(row.querySelectorAll('div')).some(e => e.textContent.trim() === ${JSON.stringify(agentTaskTitle)})).getAttribute('data-message-id')`,
      ),
    );
    await browser("click", 'nav[aria-label="Chat / Tasks"] button:last-child');
    const agentTaskReviewed = `Array.from(document.querySelectorAll('section[aria-label="In review"] article')).some(e => Array.from(e.querySelectorAll('span')).some(s => s.textContent.trim() === ${JSON.stringify(agentTaskTitle)}) && e.textContent.includes(${JSON.stringify(name)}))`;
    await browser("wait", "--fn", agentTaskReviewed, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", agentTaskReviewed))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", agentTaskReviewed);
    expect(JSON.parse(await browser("eval", agentTaskReviewed))).toBe(true);
    expect(JSON.parse(await browser("eval", taskDone))).toBe(true);
    await browser(
      "screenshot",
      resolve(import.meta.dir, "../../.amp/in/artifacts/native-browser-agent-task.png"),
    );
    await browser("find", "text", agentTaskTitle, "click", "--exact");
    await browser(
      "wait",
      "--fn",
      `location.hash === ${JSON.stringify(`#message-${agentTaskMessageId}`)}`,
    );
    expect(JSON.parse(await browser("eval", agentTaskMessage))).toBe(true);
    console.log("native_browser:reassign_task");
    await browser("click", 'nav[aria-label="Chat / Tasks"] button:last-child');
    await browser("wait", "--fn", agentTaskReviewed);
    // This harness uses the documented disposable dev-browser identity.
    for (const [handle, owner, previousOwner] of [
      ["dev-user", "@dev-user", name],
      [name, name, "@dev-user"],
    ]) {
      const reassigned = `Array.from(document.querySelectorAll('section[aria-label="In review"] article')).some(e => Array.from(e.querySelectorAll('span')).some(s => s.textContent.trim() === ${JSON.stringify(agentTaskTitle)}) && e.textContent.includes(${JSON.stringify(owner)}) && !e.textContent.includes(${JSON.stringify(previousOwner)}))`;
      const menuLabel: string = JSON.parse(
        await browser(
          "eval",
          `Array.from(document.querySelectorAll('article')).find(e => Array.from(e.querySelectorAll('span')).some(s => s.textContent.trim() === ${JSON.stringify(agentTaskTitle)})).querySelector('button[aria-label^="More actions"]').getAttribute('aria-label')`,
        ),
      );
      await click("button", menuLabel);
      await click("menuitem", "View and edit");
      await browser(
        "find",
        "role",
        "textbox",
        "fill",
        "--name",
        "Assignee handle",
        "--exact",
        `@${handle}`,
      );
      await click("button", "Assign");
      await browser("wait", "--fn", reassigned);
      await browser("find", "last", '[role="dialog"] button', "click");
      await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
      expect(JSON.parse(await browser("eval", reassigned))).toBe(true);
      await browser("reload");
      await browser("wait", "--fn", reassigned);
      expect(JSON.parse(await browser("eval", reassigned))).toBe(true);
      expect(JSON.parse(await browser("eval", taskDone))).toBe(true);
    }
    console.log("native_browser:offline_task");
    computerStopped = true;
    await controlComputer("stop");
    // Stop awaits the native Workspace process shutdown. The Web Online badge
    // is a leased loader snapshot, not evidence of whether that process stopped.
    await browser("open", `${origin}/en/messages/${agentId}?view=tasks`);
    await click("button", "Create task");
    const offlineTitle = `OFFLINE_${crypto.randomUUID()}: Create offline-result.txt containing recovered task, then submit this task for review.`;
    await browser("find", "role", "textbox", "fill", "--name", "Task 1", "--exact", offlineTitle);
    await browser("click", '[role="dialog"] button[type="submit"]');
    await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
    await browser("click", 'nav[aria-label="Chat / Tasks"] button:last-child');
    const offlineTodo = `Array.from(document.querySelectorAll('section[aria-label="To do"] article')).some(e => e.textContent.includes(${JSON.stringify(offlineTitle)}))`;
    await browser("wait", "--fn", offlineTodo);
    expect(JSON.parse(await browser("eval", offlineTodo))).toBe(true);
    await controlComputer("start");
    computerStopped = false;
    const offlineReviewed = `Array.from(document.querySelectorAll('section[aria-label="In review"] article')).some(e => e.textContent.includes(${JSON.stringify(offlineTitle)}) && e.textContent.includes(${JSON.stringify(name)}))`;
    await browser("wait", "--fn", offlineReviewed, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", offlineReviewed))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", offlineReviewed);
    expect(JSON.parse(await browser("eval", offlineReviewed))).toBe(true);
    console.log("native_browser:muted_assignment");
    const mutedTitle = `MUTED_${crypto.randomUUID()}`;
    const muteReady = `READY_${crypto.randomUUID()}`;
    await click("button", "Chat");
    await browser("wait", "--fn", "document.querySelector('textarea')?.disabled === false");
    await browser(
      "find",
      "role",
      "textbox",
      "fill",
      "--name",
      "Message",
      "--exact",
      `Mute #general notifications using CoForge. Create a new unassigned task in #general titled exactly ${mutedTitle}. Its work is to create muted-result.txt containing assigned while muted and submit for review. Do not claim or execute it until someone assigns it to you. Reply here with exactly ${muteReady} after muting and creating it; do not wait for assignment in this turn.`,
    );
    await click("button", "Send");
    const readyPresent = `Array.from(document.querySelectorAll('[data-message-id]')).some(row => row.querySelector('[data-message="other"]') && Array.from(row.querySelectorAll('div')).some(e => e.textContent.trim() === ${JSON.stringify(muteReady)}))`;
    await browser("wait", "--fn", readyPresent, "--timeout", "180000");
    await click("link", "general");
    await browser("wait", "--fn", "!!document.querySelector('nav[aria-label=\"Chat / Tasks\"]')");
    await browser("click", 'nav[aria-label="Chat / Tasks"] button:last-child');
    const mutedTodo = `Array.from(document.querySelectorAll('section[aria-label="To do"] article')).some(e => Array.from(e.querySelectorAll('span')).some(s => s.textContent.trim() === ${JSON.stringify(mutedTitle)}) && e.textContent.includes('Unassigned'))`;
    await browser("wait", "--fn", mutedTodo);
    expect(JSON.parse(await browser("eval", mutedTodo))).toBe(true);
    const mutedMenu: string = JSON.parse(
      await browser(
        "eval",
        `Array.from(document.querySelectorAll('article')).find(e => Array.from(e.querySelectorAll('span')).some(s => s.textContent.trim() === ${JSON.stringify(mutedTitle)})).querySelector('button[aria-label^="More actions"]').getAttribute('aria-label')`,
      ),
    );
    await click("button", mutedMenu);
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
      "document.querySelector('[role=dialog] input[placeholder=\"@handle\"]')?.value === ''",
    );
    await browser("find", "last", '[role="dialog"] button', "click");
    await browser("wait", "--fn", "!document.querySelector('[role=dialog]')");
    const mutedReviewed = `Array.from(document.querySelectorAll('section[aria-label="In review"] article')).some(e => Array.from(e.querySelectorAll('span')).some(s => s.textContent.trim() === ${JSON.stringify(mutedTitle)}) && e.textContent.includes(${JSON.stringify(name)}))`;
    await browser("wait", "--fn", mutedReviewed, "--timeout", "180000");
    expect(JSON.parse(await browser("eval", mutedReviewed))).toBe(true);
    await browser("reload");
    await browser("wait", "--fn", mutedReviewed);
    expect(JSON.parse(await browser("eval", mutedReviewed))).toBe(true);
    console.log(
      JSON.stringify({
        event: "native_browser:passed",
        agentId,
        name,
        replyPersisted: true,
        attachmentReplyPersisted: true,
        taskReviewPersisted: true,
        taskDonePersisted: true,
        agentCreatedTaskPersisted: true,
        taskReassignmentPersisted: true,
        offlineTaskRecovered: true,
        mutedAssignmentReviewed: true,
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
    const cleanup = await Promise.allSettled([
      computerStopped ? controlComputer("start") : Promise.resolve(),
      rm(attachmentDir, { recursive: true, force: true }),
      browser("close"),
    ]);
    for (const result of cleanup) {
      if (result.status !== "rejected") continue;
      if (!failed) throw result.reason;
      console.error("native_browser:cleanup_failed", result.reason);
    }
  }
}, 900_000);
