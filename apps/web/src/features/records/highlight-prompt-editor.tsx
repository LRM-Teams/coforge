import { RefreshCcw01 as Refresh } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import type { HighlightPromptState } from "./records-content";

export function HighlightPromptEditor({
  prompt,
  text,
  busy,
  onChange,
}: {
  prompt: HighlightPromptState;
  text: string;
  busy?: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-primary">{m.records_highlight_prompt_label()}</h2>
        <textarea
          aria-label={m.records_highlight_prompt_label()}
          value={text}
          disabled={busy}
          rows={10}
          onChange={(event) => onChange(event.target.value)}
          placeholder={m.records_highlight_prompt_placeholder()}
          className="w-full resize-y rounded-xl border border-secondary bg-primary px-3 py-3 text-sm leading-6 text-primary outline-none placeholder:text-placeholder focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-primary">
          {m.records_highlight_prompt_history()}
        </h2>
        {prompt.history.length === 0 ? (
          <p className="text-sm text-tertiary">{m.records_highlight_prompt_history_empty()}</p>
        ) : (
          <ul className="space-y-4">
            {prompt.history.map((entry) => (
              <li key={`${entry.updatedAt}-${entry.text.slice(0, 24)}`} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-tertiary">
                    {m.records_highlight_prompt_updated({
                      time: new Date(entry.updatedAt).toLocaleString(),
                    })}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    color="link-gray"
                    iconLeading={Refresh}
                    isDisabled={busy}
                    onPress={() => onChange(entry.text)}
                  >
                    {m.records_highlight_prompt_reuse()}
                  </Button>
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
