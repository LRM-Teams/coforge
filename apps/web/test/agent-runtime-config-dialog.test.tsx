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

/**
 * The Pi Provider picker's option set doesn't depend on the Computer's catalog (only the Model list
 * does), so it renders even though `renderToStaticMarkup` never runs the catalog-loading effect.
 */
test("Pi offers Configured, DeepSeek and OpenRouter as Provider options, with no hint line", () => {
  const piInitial = {
    provider: RUNTIME_PROVIDER.PI,
    modelProvider: "",
    model: "",
    reasoning: "",
  };
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      credentialConfigured={false}
      initial={piInitial}
      onLoad={noopLoad}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_form_pi_provider_configured());
  expect(markup).toContain("DeepSeek");
  expect(markup).toContain("OpenRouter");
  // The explanation line that used to sit under the picker is gone (the picker's own labels and
  // the API-key field cover it), so the Pi setup path appears nowhere in the form.
  expect(markup).not.toContain("~/.pi/agent");
  // Configured mode never shows the "{provider} API key" field.
  expect(markup).not.toContain(m.agent_form_api_key_preserve_help());
});

test("a saved Pi built-in provider with a stored credential shows the preserve-key hint, not a required key", () => {
  const piInitial = {
    provider: RUNTIME_PROVIDER.PI,
    modelProvider: "deepseek",
    model: "deepseek-chat",
    reasoning: "",
  };
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      credentialConfigured
      initial={piInitial}
      onLoad={noopLoad}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_runtime_api_key({ provider: "deepseek" }));
  expect(markup).toContain(m.agent_form_api_key_preserve_help());
  expect(markup).not.toContain(' required=""');
  // A key-passing choice gets no Pi-setup explanation either: the line was removed for every Pi
  // provider, not just Configured.
  expect(markup).not.toContain("~/.pi/agent");
});

test("a saved Pi provider outside the built-in set (e.g. zai) is still offered, so opening the dialog doesn't silently change it", () => {
  const piInitial = {
    provider: RUNTIME_PROVIDER.PI,
    modelProvider: "zai",
    model: "zai-model",
    reasoning: "",
  };
  const markup = renderToStaticMarkup(
    <AgentRuntimeConfigForm
      computerId="computer-1"
      credentialConfigured
      initial={piInitial}
      onLoad={noopLoad}
      saving={false}
      error=""
      onSave={() => {}}
    />,
  );
  expect(markup).toContain("zai");
  expect(markup).toContain(m.agent_runtime_api_key({ provider: "zai" }));
});
