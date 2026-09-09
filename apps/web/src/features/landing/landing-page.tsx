import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex.svg";
import grokMark from "@lobehub/icons-static-svg/icons/grok.svg";
import openCodeMark from "@lobehub/icons-static-svg/icons/opencode.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";
import { Check, ChevronDown, Languages } from "lucide-react";
import { MotionConfig, motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useEffect, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AnimatedSpan, Terminal, TypingAnimation } from "@/components/magicui/terminal";
import AnimatedGradient from "@/components/spell/animated-gradient";
import { BlurReveal } from "@/components/spell/blur-reveal";
import { ShimmerText } from "@/components/spell/shimmer-text";
import { installCommands, setupCommand } from "@/features/install/install-commands";
import { cn } from "@/lib/utils";
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

// The code agents shown on the landing page. The first three are what the daemon adapts today;
// OpenCode and Grok are listed ahead of their adapters at Frank's request (2026-09-08).
// Marks come from LobeHub's static icon set; the monochrome ones take the text colour via a mask.
const supportedAgents = [
  { name: "Claude Code", mark: claudeCodeMark, monochrome: false },
  { name: "Codex", mark: codexMark, monochrome: true },
  { name: "Pi", mark: piMark, monochrome: true },
] as const;
const upcomingAgents = [
  { name: "OpenCode", mark: openCodeMark, monochrome: true },
  { name: "Grok", mark: grokMark, monochrome: true },
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
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={m.landing_language()}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <Languages aria-hidden="true" className="size-4" />
        {locales.find((locale) => locale.code === active)?.label}
        <ChevronDown aria-hidden="true" className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="dark min-w-36">
        {locales.map((locale) => (
          <DropdownMenuItem
            key={locale.code}
            render={<a href={locale.href} />}
            aria-label={locale.name()}
            aria-current={locale.code === active ? "true" : undefined}
          >
            {locale.code === "en" ? "English" : "简体中文"}
            {locale.code === active && <Check aria-hidden="true" className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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

  // The first screen leaves as the reader scrolls: it shrinks a touch, drifts up and fades, driven
  // by scroll position rather than a timer, so it always matches the reader's hand.
  const { scrollY } = useScroll();
  const heroOpacity = useTransform(scrollY, [0, 420], [1, 0]);
  const heroY = useTransform(scrollY, [0, 420], [0, -60]);
  const heroScale = useTransform(scrollY, [0, 420], [1, 0.965]);
  const heroStyle = reducedMotion
    ? undefined
    : { opacity: heroOpacity, y: heroY, scale: heroScale };

  return (
    <MotionConfig reducedMotion="user">
      {/* The document itself goes dark too, so overscroll and rounded window corners never show white. */}
      <style>{`html,body{background:#0a0912;color-scheme:dark}html{scroll-snap-type:y proximity}`}</style>
      <div className="relative isolate flex min-h-dvh flex-col overflow-x-clip bg-[#0a0912] font-display text-white antialiased">
        {/* The animated gradient is the whole picture; the type sits on it like a poster. */}
        {gradientReady && (
          <AnimatedGradient config={heroGradient} theme="dark" paused={reducedMotion} />
        )}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-[1] bg-[linear-gradient(180deg,rgba(10,9,18,0.35)_0%,rgba(10,9,18,0.05)_35%,rgba(10,9,18,0.55)_75%,rgba(10,9,18,0.85)_100%)]"
        />

        <header className="flex h-19 w-full shrink-0 snap-start items-center justify-between px-5 sm:px-8">
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
              className={buttonVariants({ size: "lg", className: "dark px-4" })}
            >
              <span>{m.landing_action_sign_up()}</span>
            </a>
          </div>
        </header>

        <main className="relative mx-auto flex min-h-[calc(100dvh-4.75rem)] w-full max-w-[1400px] shrink-0 flex-col justify-center px-6 pt-8 pb-16">
          <motion.div style={heroStyle} className="flex flex-col items-center">
            <div className="relative w-full py-16 sm:py-20">
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
              <ScatteredAgents />
            </div>

            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 1, ease: "easeOut" }}
              className="mx-auto max-w-xl text-center text-base text-pretty text-white/70 sm:text-lg"
            >
              {m.landing_description()}
            </motion.p>
          </motion.div>

          <motion.a
            href="#computer"
            aria-label={m.landing_scroll_hint()}
            style={reducedMotion ? undefined : { opacity: heroOpacity }}
            className="absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 text-[11px] tracking-[0.2em] text-white/40 uppercase transition-colors hover:text-white/70"
          >
            {m.landing_scroll_hint()}
            <ChevronDown aria-hidden="true" className="size-4 animate-bounce" />
          </motion.a>
        </main>

        <section
          id="computer"
          className="mx-auto flex min-h-dvh w-full max-w-6xl shrink-0 snap-start flex-col items-center justify-center px-6 py-20 text-center"
        >
          <BlurReveal
            as="h2"
            inView
            speedReveal={1.4}
            className="max-w-3xl text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl lg:text-5xl"
          >
            {m.landing_computer_title()}
          </BlurReveal>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, delay: 0.35, ease: "easeOut" }}
            className="mt-4 max-w-xl text-base text-pretty text-white/60 sm:text-lg"
          >
            {m.landing_computer_body()}
          </motion.p>
          <div
            role="region"
            aria-label={m.landing_terminal_label()}
            className="mt-10 w-full max-w-2xl text-left"
          >
            <InstallTerminal installOrigin={installOrigin} />
          </div>
        </section>
      </div>
    </MotionConfig>
  );
}

// Fixed, asymmetric positions keep the relaxed composition stable across SSR and refreshes.
// The title owns this frame at every width; narrow screens shrink the tiles, never move them below.
const agentPositions = [
  "top-[38%] left-0 -rotate-12 lg:left-[3%] lg:size-24",
  "top-[24%] right-0 rotate-12 lg:right-[3%] lg:size-24",
  "top-0 left-[17%] rotate-6 lg:size-16",
  "top-[60%] right-0 -rotate-6 lg:right-[12%] lg:size-20",
  "top-[72%] left-0 -rotate-12 lg:left-[9%] lg:size-20",
];

function ScatteredAgents() {
  return (
    <ul aria-label={m.landing_agents_title()} className="pointer-events-none absolute inset-0">
      {[...supportedAgents, ...upcomingAgents].map((agent, index) => (
        <li
          key={agent.name}
          className={cn(
            "absolute flex size-10 items-center justify-center rounded-xl border border-white/15 bg-terminal/85 shadow-lg shadow-black/30 sm:size-14 lg:rounded-2xl lg:[&>img]:size-1/2 lg:[&>span[aria-hidden]]:size-1/2",
            agentPositions[index],
          )}
        >
          <span className="sr-only">{agent.name}</span>
          <AgentMark mark={agent.mark} monochrome={agent.monochrome} />
        </li>
      ))}
    </ul>
  );
}

// The second-screen walkthrough is a demonstration, not the first-screen install action.
function InstallTerminal({ installOrigin }: { installOrigin: string }) {
  return (
    <Terminal className="min-h-88 max-h-none max-w-none border-white/10 bg-terminal/85 shadow-2xl shadow-black/40 backdrop-blur-md [&_code]:grid-cols-1 [&_code]:font-display-mono [&_code]:[overflow-wrap:anywhere] [&_pre]:text-[13px] [&_pre]:leading-6 [&_pre]:whitespace-pre-wrap">
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
