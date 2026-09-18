import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { AgentRuntimeConfigForm } from "@/features/agents/agent-runtime-config-dialog";
import { m } from "@/paraglide/messages";

/**
 * `AgentRuntimeConfigDialog` wraps this form in `ModalOverlay`/`Modal`/`Dialog`
 * (`@/components/application/modals/modal`, the same shell `AgentRuntimeCredentialDialog` uses).
 * Verified directly: rendering that dialog with `renderToStaticMarkup` produces an empty string
 * (no thrown error) because `Modal` needs a real browser portal target `renderToStaticMarkup`
 * cannot provide. So this file renders `AgentRuntimeConfigForm` — the dialog's plain, Modal-free
 * form body — instead of the dialog shell.
 */
const noopLoad = async () => ({ providers: [], catalogs: [] });

const initial = {
  provider: RUNTIME_PROVIDER.CODEX,
  modelProvider: "openai",
  model: "gpt-5.1-codex",
  reasoning: "high",
};

test("renders the title, Provider and Model labels, and Cancel; Reasoning waits for the catalog", () => {
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      credentialConfigured={false}
      initial={initial}
      onLoad={noopLoad}
      saving={false}
      error=""
      onClose={() => {}}
      onSave={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_profile_edit_runtime_config());
  expect(markup).toContain(m.agent_form_provider());
  expect(markup).toContain(m.agent_form_model());
  // `renderToStaticMarkup` never runs effects, so the catalog load never resolves and the
  // configured model is never confirmed against it. The Reasoning field must stay hidden here.
  expect(markup).not.toContain(m.agent_form_reasoning());
  expect(markup).toContain(m.controls_cancel());
  expect(markup).toContain(m.agent_profile_save_runtime_config());
});

test("Save starts disabled: nothing has changed away from the Agent's current runtime config yet", () => {
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      initial={initial}
      onLoad={noopLoad}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  // The submit (Save) button is the last <button>...</button> in the footer; assert it carries
  // `disabled` rather than matching on class names, which are implementation detail.
  const saveButton = markup.slice(markup.lastIndexOf("<button"));
  expect(saveButton).toContain(m.agent_profile_save_runtime_config());
  expect(saveButton).toContain(' disabled=""');
});

test("Save reads the saving copy and stays disabled while the panel is saving", () => {
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      initial={initial}
      onLoad={noopLoad}
      saving
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_profile_saving());
  const saveButton = markup.slice(markup.lastIndexOf("<button"));
  expect(saveButton).toContain(' disabled=""');
});

test("a failed save shows an inline alert line, never a toast", () => {
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      initial={initial}
      onLoad={noopLoad}
      saving={false}
      error={m.agent_form_runtime_unavailable()}
      onSave={() => {}}
    />,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain(m.agent_form_runtime_unavailable());
});

test("a non-owner viewer (no `environment` prop) never renders the Advanced env disclosure", () => {
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      initial={initial}
      onLoad={noopLoad}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).not.toContain(m.agent_env_advanced());
});

test("the owner's Advanced disclosure renders closed by default with the hint copy", () => {
  // The env rows themselves come from a `useEffect` seed (`environment.values` -> `envRows`),
  // which never runs under `renderToStaticMarkup` (no DOM, no effects) — same SSR limitation the
  // file header notes for `AgentRuntimeFields`. This asserts the static shell: the trigger, the
  // panel rendered `hidden` (collapsed by default), and the Add/hint copy that doesn't depend on
  // any seeded row.
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      initial={initial}
      onLoad={noopLoad}
      environment={{ loaded: true, values: { API_TOKEN: "secret" } }}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_env_advanced());
  expect(markup).toContain('hidden=""');
  expect(markup).not.toContain('data-expanded="true"');
  expect(markup).toContain(m.agent_env_hint());
  expect(markup).toContain(m.agent_env_add());
});

test("Save stays disabled while the owner's env query has not loaded yet, showing the loading copy", () => {
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      initial={initial}
      onLoad={noopLoad}
      environment={{ loaded: false, values: {} }}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_env_loading());
  const saveButton = markup.slice(markup.lastIndexOf("<button"));
  expect(saveButton).toContain(' disabled=""');
});
