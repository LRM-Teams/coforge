import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";
import { Check, ChevronDown, Translate01 as Languages } from "@untitledui/icons";
import { MotionConfig, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { Button as AriaButton } from "react-aria-components";

import { Dropdown } from "@/components/base/dropdown/dropdown";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/components/magicui/terminal";
import AnimatedGradient from "@/components/spell/animated-gradient";
import { BlurReveal } from "@/components/spell/blur-reveal";
import { ShimmerText } from "@/components/spell/shimmer-text";
import { installCommands, setupCommand } from "@/features/install/install-commands";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export const repositoryUrl = "https://github.com/LRM-Teams/coforge";

// The landing page is dark in both themes, so the gradient carries one fixed palette: the page
// ground, the brand purple, and the light accent lavender. Shape and swirl follow Spell's "Prism"
// preset, slowed down so it reads as ambient light behind the type.
const heroGradient = {
  preset: "custom",
  color1: "#0a0912",
  color2: "#5d36dc",
  color3: "#c5bafe",
  rotation: -50,
  proportion: 42,
  scale: 0.4,
  speed: 8,
  distortion: 3,
  swirl: 55,
  swirlIterations: 12,
  softness: 100,
  offset: -299,
  shape: "Checks",
  shapeSize: 45,
} as const;

// The code agents supported by the daemon and shown in the terminal demonstration.
// Marks come from LobeHub's static icon set; the monochrome ones take the text colour via a mask.
const supportedAgents = [
  { name: "Claude Code", mark: claudeCodeMark, monochrome: false },
  { name: "Codex", mark: codexMark, monochrome: true },
  { name: "Pi", mark: piMark, monochrome: true },
] as const;

// Lucide dropped brand marks, so the GitHub octicon is inlined here.
function GitHubMark({ className = "size-4 shrink-0" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function AgentMark({ mark, monochrome }: { mark: string; monochrome: boolean }) {
  if (!monochrome) {
    return <img src={mark} alt="" className="size-5 shrink-0" />;
  }
  return (
    <span
      aria-hidden="true"
      className="size-5 shrink-0 bg-white mask-contain mask-center mask-no-repeat"
      // Vite inlines small SVGs as data URLs that contain quotes, so the url() must be quoted.
      style={{ maskImage: `url("${mark}")`, WebkitMaskImage: `url("${mark}")` }}
    />
  );
}

// Language endonyms stay untranslated, the way every locale switcher shows them;
// the accessible names come from the shared control catalog.
const locales = [
  {
    code: "en",
    label: "EN",
    href: "/en",
    name: () => m.controls_switch_to_english(),
  },
  {
    code: "zh-CN",
    label: "中文",
    href: "/zh-CN",
    name: () => m.controls_switch_to_chinese(),
  },
] as const;

function LocaleSwitch() {
  const active = getLocale();
  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={m.landing_language()}
        className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-xs font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <Languages aria-hidden="true" className="size-4" />
        {locales.find((locale) => locale.code === active)?.label}
        <ChevronDown aria-hidden="true" className="size-3" />
      </AriaButton>
      <Dropdown.Popover placement="bottom end" className="dark-mode w-40">
        <Dropdown.Menu
          aria-label={m.landing_language()}
          selectionMode="none"
          items={locales.map((locale) => ({ ...locale }))}
        >
          {(locale) => (
            <Dropdown.Item
              id={locale.code}
              href={locale.href}
              aria-label={locale.name()}
              data-current={locale.code === active ? "true" : undefined}
              label={locale.code === "en" ? "English" : "简体中文"}
              icon={locale.code === active ? Check : undefined}
            />
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/** The gradient is WebGL2 and decorative: it exists only after mount, and only where it can draw. */
function useWebGl2() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(document.createElement("canvas").getContext("webgl2") !== null);
  }, []);
  return ready;
}

export function LandingPage({ installOrigin }: { installOrigin: string }) {
  const gradientReady = useWebGl2();
  const reducedMotion = useReducedMotion() ?? false;
  const headline = `${m.landing_headline_line_1()} ${m.landing_headline_line_2()}`;

  return (
    <MotionConfig reducedMotion="user">
      {/* The document itself goes dark too, so overscroll and rounded window corners never show white. */}
      <style>{`html,body{background:#0a0912;color-scheme:dark}`}</style>
      <div className="landing-page relative isolate flex min-h-dvh flex-col overflow-x-clip bg-[#0a0912] font-display text-white antialiased">
        {/* The animated gradient is the whole picture; the type sits on it like a poster. */}
        {gradientReady && (
          <AnimatedGradient config={heroGradient} theme="dark" paused={reducedMotion} />
        )}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-[1] bg-[linear-gradient(180deg,rgba(10,9,18,0.35)_0%,rgba(10,9,18,0.05)_35%,rgba(10,9,18,0.55)_75%,rgba(10,9,18,0.85)_100%)]"
        />

        <header className="flex h-19 w-full shrink-0 items-center justify-between px-5 sm:px-8">
          <a href="/" className="shrink-0" aria-label="CoForge">
            <img src="/coforge-brand.svg" alt="" className="h-5 w-auto min-[400px]:h-6 sm:h-8" />
          </a>
          <div className="flex items-center gap-2 sm:gap-3">
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={m.landing_action_repository()}
              className="flex size-8 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <GitHubMark className="size-[18px]" />
            </a>
            <LocaleSwitch />
            <a
              href="/auth/login"
              className="flex h-9 items-center rounded-full px-2 text-sm font-medium whitespace-nowrap text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:px-3"
            >
              <span>{m.landing_action_sign_in()}</span>
            </a>
            <a
              href="/auth/login"
              className="flex h-9 items-center rounded-lg bg-white px-4 text-sm font-medium whitespace-nowrap text-gray-900 transition-colors hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <span>{m.landing_action_sign_up()}</span>
            </a>
          </div>
        </header>

        <main className="relative mx-auto flex min-h-[calc(100dvh-4.75rem)] w-full max-w-[1400px] shrink-0 flex-col justify-center px-6 pt-4 pb-8">
          <div className="flex flex-col items-center">
            <div className="relative w-full py-12 sm:py-10">
              <div className="mx-auto w-full min-w-0 max-w-2xl px-12 text-center sm:px-24 lg:w-[64%] lg:px-0">
                <ShimmerText
                  className="text-xs font-medium tracking-[0.22em] text-white/55 uppercase [--shimmer-contrast:rgba(255,255,255,1)]"
                  duration={1.6}
                  delay={1.4}
                >
                  {m.landing_eyebrow()}
                </ShimmerText>

                <h1 className="sr-only">{headline}</h1>
                <div
                  aria-hidden="true"
                  className="mt-5 text-[clamp(1.25rem,6.8vw,1.65rem)] leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[clamp(2rem,4.8vw,4.25rem)]"
                >
                  <BlurReveal as="span" className="block" speedReveal={1.2}>
                    {m.landing_headline_line_1()}
                  </BlurReveal>
                  <BlurReveal as="span" className="block" speedReveal={1.2} delay={0.35}>
                    {m.landing_headline_line_2()}
                  </BlurReveal>
                </div>
              </div>
            </div>

            <div
              role="region"
              aria-label={m.landing_terminal_label()}
              className="mt-4 w-full max-w-2xl text-left"
            >
              <InstallTerminal installOrigin={installOrigin} />
            </div>
          </div>
        </main>
      </div>
    </MotionConfig>
  );
}

// This walkthrough is a demonstration; actionable setup belongs in the Computer UI.
function InstallTerminal({ installOrigin }: { installOrigin: string }) {
  return (
    <Terminal className="dark-mode min-h-88 max-h-none max-w-none border-secondary bg-terminal/85 shadow-2xl shadow-black/40 backdrop-blur-md [&>div:first-child]:border-secondary [&_code]:grid-cols-1 [&_code]:font-display-mono [&_code]:[overflow-wrap:anywhere] [&_pre]:text-[13px] [&_pre]:leading-6 [&_pre]:whitespace-pre-wrap">
      <TypingAnimation className="text-white/90" duration={28} delay={300}>
        {`$ ${installCommands(installOrigin).posix}`}
      </TypingAnimation>
      <AnimatedSpan className="text-emerald-400">✔ {m.landing_terminal_installed()}</AnimatedSpan>
      <TypingAnimation className="text-white/90" duration={28}>
        {`$ ${setupCommand("acme")}`}
      </TypingAnimation>
      <AnimatedSpan className="text-emerald-400">✔ {m.landing_terminal_connected()}</AnimatedSpan>
      <AnimatedSpan className="text-white/60">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          ℹ {m.landing_terminal_runtimes()}
          {supportedAgents.map((agent) => (
            <span key={agent.name} className="inline-flex items-center gap-1.5 text-white/85">
              <AgentMark mark={agent.mark} monochrome={agent.monochrome} />
              {agent.name}
            </span>
          ))}
        </span>
      </AnimatedSpan>
      <AnimatedSpan className="text-emerald-400">
        ✔ {m.landing_terminal_agent_online()}
      </AnimatedSpan>
      <AnimatedSpan className="text-white/50">{m.landing_terminal_hint()}</AnimatedSpan>
    </Terminal>
  );
}
