import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type AgentEnvironmentEditorProps = {
  onLoad: () => Promise<Record<string, string>>;
  onSave: (envVars: Record<string, string>) => Promise<{ restart: "published" | "deferred" }>;
};

export function AgentEnvironmentEditor({ onLoad, onSave }: AgentEnvironmentEditorProps) {
  const [rows, setRows] = useState<Array<{ name: string; value: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function edit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await onLoad();
      setRows(Object.entries(saved).map(([name, value]) => ({ name, value })));
    } catch {
      setError(m.agent_env_load_failed());
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (pending.current || !rows) return;
    const entries = rows.map(({ name, value }) => [name.trim(), value] as const);
    const names = entries.map(([name]) => name);
    if (
      names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(names).size !== names.length
    ) {
      setError(m.agent_env_invalid_names());
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await onSave(Object.fromEntries(entries));
      setRows(null);
      setNotice(result.restart === "published" ? m.agent_env_saved() : m.agent_env_deferred());
    } catch {
      setError(m.agent_env_save_failed());
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const inputClass =
    "h-10 min-w-0 w-full rounded-lg border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <section className="grid gap-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
      <h2 className="text-base font-semibold">{m.agent_env_title()}</h2>
      <div className="min-w-0 space-y-4">
        {rows === null ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void edit()}>
            {busy ? m.agent_env_loading() : m.agent_env_edit()}
          </Button>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {rows.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
              >
                <input
                  aria-label={m.agent_env_name({ index: index + 1 })}
                  placeholder="VARIABLE_NAME"
                  value={row.name}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${inputClass} col-span-2 sm:col-span-1`}
                  onChange={(e) =>
                    setRows(rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
                  }
                />
                <input
                  aria-label={m.agent_env_value({ index: index + 1 })}
                  value={row.value}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                  onChange={(e) =>
                    setRows(rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  aria-label={m.agent_env_remove_label({ index: index + 1 })}
                  onClick={() => setRows(rows.filter((_, i) => i !== index))}
                >
                  {m.agent_env_remove()}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || rows.length >= 64}
              onClick={() => setRows([...rows, { name: "", value: "" }])}
            >
              {m.agent_env_add()}
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {m.agent_env_save()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setRows(null);
                  setError("");
                }}
              >
                {m.controls_cancel()}
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
