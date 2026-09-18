import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { cn } from "@/lib/utils";
import {
  RUNTIME_PROVIDER_MARK,
  RUNTIME_PROVIDER_MARK_IS_COLOR_ICON,
} from "./runtime-provider-display";

/**
 * A provider's mark at any size: full-colour marks render as an `<img>`, monochrome glyphs as a
 * CSS mask so they follow the current text colour. Shared by the runtime picker, the Agent
 * profile panel's Runtime badge and the Computer page's runtime rows.
 */
export function RuntimeProviderMark({
  provider,
  className = "size-4",
}: {
  provider: RuntimeProvider;
  className?: string;
}) {
  const mark = RUNTIME_PROVIDER_MARK[provider];
  if (RUNTIME_PROVIDER_MARK_IS_COLOR_ICON[provider])
    return <img src={mark} alt="" className={cn("shrink-0", className)} />;
  return (
    <span
      aria-hidden="true"
      className={cn("shrink-0 bg-fg-primary mask-contain mask-center mask-no-repeat", className)}
      style={{ maskImage: `url("${mark}")`, WebkitMaskImage: `url("${mark}")` }}
    />
  );
}
