import type { Ref } from "react";
import { RefreshCcw01 as Refresh, Trash01 as Trash } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import type { KeyPointPromptState } from "./records-content";

/** Current prompt + history with「重新启用」/「删除」(settings 要点提示词模板). */
export function KeyPointPromptEditor({
  prompt,
  text,
  busy,
  textareaRef,
  onChange,
  onFocus,
  onBlur,
  onDeleteHistory,
}: {
  prompt: KeyPointPromptState;
  text: string;
  busy?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onChange: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onDeleteHistory?: (historyIndex: number) => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-primary">
          {m.records_key_points_prompt_label()}
        </h2>
        <textarea
          ref={textareaRef}
          aria-label={m.records_key_points_prompt_label()}
          value={text}
          // Keep editable while saving so React does not re-apply a stale `value` via disabled.
          readOnly={busy}
          rows={10}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onCompositionEnd={(event) => onChange(event.currentTarget.value)}
          placeholder={m.records_key_points_prompt_placeholder()}
          className="w-full resize-y rounded-xl border border-secondary bg-primary px-3 py-3 text-sm leading-6 text-primary outline-none placeholder:text-placeholder focus:border-brand focus:ring-1 focus:ring-brand read-only:opacity-80"
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-primary">
          {m.records_key_points_prompt_history()}
        </h2>
        {prompt.history.length === 0 ? (
          <p className="text-sm text-tertiary">{m.records_key_points_prompt_history_empty()}</p>
        ) : (
          <ul className="space-y-4">
            {prompt.history.map((entry, historyIndex) => (
              <li key={`${entry.updatedAt}-${historyIndex}`} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-tertiary">
                    {m.records_key_points_prompt_updated({
                      time: new Date(entry.updatedAt).toLocaleString(),
                    })}
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      color="link-gray"
                      iconLeading={Refresh}
                      isDisabled={busy}
                      onPress={() => onChange(entry.text)}
                    >
                      {m.records_key_points_prompt_reuse()}
                    </Button>
                    {onDeleteHistory ? (
                      <Button
                        type="button"
                        size="sm"
                        color="tertiary-destructive"
                        iconLeading={Trash}
                        isDisabled={busy}
                        onPress={() => onDeleteHistory(historyIndex)}
                      >
                        {m.records_key_points_prompt_history_delete()}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="rounded-xl bg-secondary px-3 py-3 text-sm leading-6 whitespace-pre-wrap text-secondary">
                  {entry.text}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
