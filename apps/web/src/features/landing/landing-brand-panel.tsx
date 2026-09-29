import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex.svg";
import cursorMark from "@lobehub/icons-static-svg/icons/cursor.svg";
import kiroMark from "@lobehub/icons-static-svg/icons/kiro-color.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import AnimatedGradient from "#src/components/spell/animated-gradient";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

// The landing page is dark in both themes, so the gradient carries one fixed palette: the page
// ground, the brand purple, and the light accent lavender. Shape and swirl follow Spell's "Prism"
// preset, slowed down so it reads as ambient light behind the type.
export const heroGradient = {
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
export const supportedAgents = [
  { name: "Claude Code", mark: claudeCodeMark, monochrome: false },
  { name: "Codex", mark: codexMark, monochrome: true },
  { name: "Pi", mark: piMark, monochrome: true },
  { name: "Kiro", mark: kiroMark, monochrome: false },
  { name: "Cursor", mark: cursorMark, monochrome: true },
] as const;

export function AgentMark({ mark, monochrome }: { mark: string; monochrome: boolean }) {
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

/** The gradient is WebGL2 and decorative: it exists only after mount, and only where it can draw. */
export function useWebGl2() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(document.createElement("canvas").getContext("webgl2") !== null);
  }, []);
  return ready;
}

/**
 * The homepage's picture in a panel: its gradient, headline, and the supported agents. Pages that
 * sit beside the product's front door (sign-in, invite links) show it next to their form.
 */
export function LandingBrandPanel({ className }: { className?: string }) {
  const gradientReady = useWebGl2();
  const reducedMotion = useReducedMotion() ?? false;
  return (
    <div
      className={cx(
        "relative isolate flex-col justify-end overflow-hidden rounded-3xl bg-[#0a0912] font-display text-white",
        className,
      )}
    >
      {gradientReady && (
        <AnimatedGradient config={heroGradient} theme="dark" paused={reducedMotion} />
      )}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-[1] bg-[linear-gradient(180deg,rgba(10,9,18,0)_40%,rgba(10,9,18,0.8)_100%)]"
      />
      <div className="p-12">
        <p className="text-display-md leading-tight font-semibold tracking-tight">
          {m.landing_headline_line_1()}
          <br />
          {m.landing_headline_line_2()}
        </p>
        <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/75">
          {supportedAgents.map((agent) => (
            <li key={agent.name} className="inline-flex items-center gap-2">
              <AgentMark mark={agent.mark} monochrome={agent.monochrome} />
              {agent.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
