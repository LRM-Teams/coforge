import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { LandingBrandPanel } from "#src/features/landing/landing-brand-panel";

/**
 * The shell of the pages people reach before they are in CoForge (sign-in, invite links): the
 * task on the left in the product's own theme, the homepage's brand panel on the right from `lg`
 * up.
 */
export function AuthSplitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-primary lg:grid-cols-2">
      <div className="flex flex-col px-4 py-8 md:px-8">
        <Link to="/" aria-label="CoForge" className="self-start">
          <img src="/logo.svg" alt="" className="size-8" />
        </Link>
        <main className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">{children}</div>
        </main>
      </div>
      <LandingBrandPanel className="m-3 hidden lg:flex" />
    </div>
  );
}
