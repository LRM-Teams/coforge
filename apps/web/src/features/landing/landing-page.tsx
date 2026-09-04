import { ArrowRight, ArrowUp, Check, Cpu, MessageCircle, Monitor } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export const repositoryUrl = "https://github.com/LRM-Teams/coforge";
const repositoryLabel = "github.com/LRM-Teams/coforge";

// The page renders outside the app shell, so it carries its own motion rules.
// Everything is CSS-only and switched off under reduced motion.
const landingStyles = `
@keyframes landing-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes landing-blink{50%{opacity:0}}
.landing-rise{animation:landing-rise .7s cubic-bezier(.2,.7,.2,1) both}
.landing-blink{animation:landing-blink 1.1s steps(1) infinite}
@media (prefers-reduced-motion:reduce){.landing-rise,.landing-blink{animation:none}}
`;

// Lucide dropped brand marks, so the GitHub octicon is inlined here.
function GitHubMark({ className = "size-4 shrink-0" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// Language endonyms stay untranslated, the way every locale switcher shows them;
// the accessible names come from the shared control catalog.
const locales = [
  { code: "en", label: "EN", href: "/en", name: () => m.controls_switch_to_english() },
  { code: "zh-CN", label: "中文", href: "/zh-CN", name: () => m.controls_switch_to_chinese() },
] as const;

function LocaleSwitch() {
  const active = getLocale();
  return (
    <div className="flex items-center rounded-md border bg-background/60 p-0.5 text-xs font-medium">
      {locales.map((locale) => (
        <a
          key={locale.code}
          href={locale.href}
          aria-label={locale.name()}
          aria-current={locale.code === active ? "true" : undefined}
          className={cn(
            "rounded-sm px-2 py-1 text-muted-foreground hover:text-foreground",
            locale.code === active && "bg-card text-foreground shadow-xs",
          )}
        >
          {locale.label}
        </a>
      ))}
    </div>
  );
}

export function LandingPage({ installScriptUrl }: { installScriptUrl: string }) {
  const teammate = { name: m.landing_scene_teammate_name(), tone: 4 as const };
  const agent = { name: m.landing_scene_agent_name(), tone: 1 as const };

  return (
    <main className="relative isolate flex min-h-svh flex-col overflow-hidden text-foreground [background:var(--sidebar-background)]">
      <style>{landingStyles}</style>
      {/* Brand glow behind the scene, from the same purple the app uses for selection. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-radial-[at_78%_32%] from-brand/20 via-transparent to-transparent dark:from-brand/25"
      />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
          <img src="/logo.svg" alt="CoForge" className="size-8" />
          CoForge
        </span>
        <div className="flex items-center gap-2">
          <LocaleSwitch />
          <a
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={m.landing_action_repository()}
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-9")}
          >
            <GitHubMark className="size-5" />
          </a>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] items-center gap-12 px-6 py-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16 lg:py-6">
        <div className="min-w-0 max-w-xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-accent/60 px-3 py-1 text-xs font-medium text-accent-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
            {m.landing_eyebrow()}
          </span>
          <h1 className="mt-6 text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
            {m.landing_headline_lead()}
            <br />
            <span className="text-brand">{m.landing_headline_highlight()}</span>
          </h1>
          <p className="mt-5 max-w-lg text-base text-pretty text-muted-foreground sm:text-lg">
            {m.landing_description()}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="/auth/login"
              className={cn(
                buttonVariants({ size: "lg" }),
                "h-11 bg-brand px-5 text-base text-brand-foreground hover:bg-brand/90",
              )}
            >
              {m.landing_action_sign_in()}
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </a>
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "h-11 gap-2 bg-card/70 px-4 font-mono text-sm",
              )}
            >
              <GitHubMark />
              {repositoryLabel}
            </a>
          </div>
        </div>

        {/* The scene: one real conversation on top of one real install. */}
        <div className="relative w-full min-w-0 lg:pr-6">
          <article className="landing-rise rounded-xl border bg-card shadow-xl shadow-brand/10 dark:shadow-black/40">
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <Avatar people={[teammate, agent]} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {m.landing_scene_conversation_title()}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.landing_scene_conversation_kind()}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                {m.landing_scene_status_online()}
              </span>
            </div>

            <ul className="flex flex-col gap-5 px-4 py-5">
              <li className="landing-rise flex justify-end" style={{ animationDelay: "0.35s" }}>
                <div className="flex max-w-[85%] items-end gap-2.5">
                  <p className="rounded-lg bg-accent px-4 py-2.5 text-sm leading-5 font-medium text-accent-foreground">
                    {m.landing_scene_user_message()}
                  </p>
                  <Avatar people={[teammate]} size="sm" />
                </div>
              </li>
              <li
                className="landing-rise flex items-start gap-2.5"
                style={{ animationDelay: "1.2s" }}
              >
                <Avatar people={[agent]} size="sm" online />
                <div className="min-w-0 max-w-[85%]">
                  <p className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{agent.name}</span>
                    <span className="rounded bg-accent/60 px-1.5 py-px text-[11px] font-medium text-accent-foreground">
                      {m.landing_scene_agent_runtime()}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Monitor aria-hidden="true" className="size-3" />
                      {m.landing_scene_computer_name()}
                    </span>
                  </p>
                  <p className="rounded-lg bg-muted px-4 py-2.5 text-sm leading-5 font-medium">
                    {m.landing_scene_agent_message()}
                  </p>
                </div>
              </li>
            </ul>

            <div className="mx-4 mb-4 flex items-center gap-2 rounded-2xl border bg-background px-3 py-2">
              <span className="flex-1 truncate text-sm text-muted-foreground">
                {m.landing_scene_composer_placeholder()}
              </span>
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground"
              >
                <ArrowUp className="size-4" />
              </span>
            </div>
          </article>

          <div
            className="landing-rise relative -mt-3 ml-auto w-full rounded-xl bg-terminal p-4 text-sm text-terminal-foreground shadow-xl ring-1 ring-white/10 sm:-mr-4 sm:w-[88%] lg:-mr-6"
            style={{ animationDelay: "0.15s" }}
          >
            <div className="flex items-center gap-2 text-xs text-terminal-foreground/60">
              <Monitor aria-hidden="true" className="size-3.5" />
              <span className="shrink-0 font-medium whitespace-nowrap text-terminal-foreground/80">
                {m.landing_scene_terminal_title()}
              </span>
              <span className="hidden min-w-0 truncate sm:inline">
                · {m.landing_scene_terminal_hint()}
              </span>
            </div>
            <pre className="mt-3 overflow-x-auto font-mono text-[13px] leading-6 whitespace-pre">
              <code>
                <span className="text-accent dark:text-accent-foreground">$ </span>
                {`curl -fsSL ${installScriptUrl} | sh`}
                {"\n"}
                <span className="landing-rise inline-block" style={{ animationDelay: "1.6s" }}>
                  <Check aria-hidden="true" className="mr-1.5 inline size-3.5 text-success" />
                  <span className="text-success">{m.landing_scene_terminal_connected()}</span>
                </span>
                {"\n"}
                <span
                  className="landing-rise inline-block text-terminal-foreground/60"
                  style={{ animationDelay: "2s" }}
                >
                  {m.landing_scene_terminal_runtimes()}
                </span>
                {"\n"}
                <span className="text-accent dark:text-accent-foreground">$ </span>
                <span
                  aria-hidden="true"
                  className="landing-blink inline-block h-3.5 w-2 translate-y-0.5 bg-terminal-foreground/80"
                />
              </code>
            </pre>
          </div>
        </div>
      </section>

      <footer className="mx-auto w-full max-w-6xl px-6 pb-8">
        <ul className="grid gap-5 border-t border-border/70 pt-6 sm:grid-cols-3 sm:gap-8">
          <LandingPoint
            icon={<MessageCircle aria-hidden="true" className="size-4" />}
            heading={m.landing_point_conversations_title()}
            body={m.landing_point_conversations_body()}
          />
          <LandingPoint
            icon={<Monitor aria-hidden="true" className="size-4" />}
            heading={m.landing_point_computers_title()}
            body={m.landing_point_computers_body()}
          />
          <LandingPoint
            icon={<Cpu aria-hidden="true" className="size-4" />}
            heading={m.landing_point_runtimes_title()}
            body={m.landing_point_runtimes_body()}
          />
        </ul>
      </footer>
    </main>
  );
}

function LandingPoint({
  icon,
  heading,
  body,
}: {
  icon: React.ReactNode;
  heading: string;
  body: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        {icon}
      </span>
      <div>
        <h2 className="text-sm font-medium">{heading}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}
