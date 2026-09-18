import { useState, type KeyboardEvent } from "react";
import { Edit01 as Pencil } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { m } from "@/paraglide/messages";

/** The panel's small uppercase field-group caption — the same style as the chat sidebar's
 * "CHANNELS" caption (`conversation-directory.tsx`), reused here for section labels (INFO,
 * RUNTIME CONFIG, ACTIONS) and the two top-level editable field labels (Display name,
 * Description). */
export const SECTION_CAPTION_CLASS =
  "text-[0.6875rem] font-semibold tracking-wide text-quaternary uppercase";

/** The secondary, non-uppercase field label used inside a fact column (Role, Computer, Created,
 * Creator, Runtime, Model, Reasoning) — smaller and quieter than the section caption above. */
export const SUBFIELD_LABEL_CLASS = "text-xs text-tertiary";

/**
 * Label-over-value inline edit: hover/focus reveals nothing extra (the pencil sits beside the
 * label, always visible to a viewer who can edit — `docs/ui-guidelines.md` §4's hover affordance
 * is for read-only-by-default fields; here the brief's approved prototype keeps the pencil
 * present). A press swaps the value for an official Input/TextArea with Save/Cancel; Escape
 * cancels. Used for Display name and Description only — Role reuses the existing `Select`, and
 * Runtime config reuses the existing credential dialog (see `agent-profile-tab.tsx`).
 */
export function InlineEditField({
  label,
  value,
  placeholder,
  multiline,
  editable,
  editLabel,
  saving,
  error,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  editable: boolean;
  editLabel: string;
  saving: boolean;
  error?: string | null;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function begin() {
    setDraft(value);
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setDraft(value);
  }
  async function save() {
    await onSave(draft);
    setEditing(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <div className="mt-5 first:mt-0">
      <div className="flex items-center gap-1.5">
        <span className={SECTION_CAPTION_CLASS}>{label}</span>
        {editable && !editing && (
          <ButtonUtility
            aria-label={editLabel}
            tooltip={editLabel}
            icon={Pencil}
            size="xs"
            color="tertiary"
            onClick={begin}
          />
        )}
      </div>
      {editing ? (
        <div className="mt-1.5" onKeyDown={onKeyDown}>
          {multiline ? (
            <TextArea
              autoFocus
              rows={3}
              value={draft}
              onChange={setDraft}
              placeholder={placeholder}
              isDisabled={saving}
            />
          ) : (
            <Input
              autoFocus
              value={draft}
              onChange={setDraft}
              placeholder={placeholder}
              isDisabled={saving}
            />
          )}
          {error && (
            <p role="alert" className="mt-1.5 text-sm text-error-primary">
              {error}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" isDisabled={saving} onPress={() => void save()}>
              {saving ? m.agent_profile_saving() : m.agent_profile_save()}
            </Button>
            <Button size="sm" color="secondary" isDisabled={saving} onPress={cancel}>
              {m.controls_cancel()}
            </Button>
          </div>
        </div>
      ) : (
        <p
          className={value ? "mt-1 text-sm font-medium text-primary" : "mt-1 text-sm text-tertiary"}
        >
          {value || "—"}
        </p>
      )}
    </div>
  );
}
