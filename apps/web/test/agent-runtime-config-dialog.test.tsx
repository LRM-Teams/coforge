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

test("renders the dialog title, the three field labels, and Cancel", () => {
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
  expect(markup).toContain(m.agent_form_reasoning());
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
