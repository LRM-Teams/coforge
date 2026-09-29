import { useAssumedPhone } from "./assumed-viewport";
import { useMediaQuery } from "./use-media-query";

const screens = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
};

/**
 * Checks whether a particular Tailwind CSS viewport size applies.
 *
 * @param size The size to check, which must either be included in Tailwind CSS's
 * list of default screen sizes, or added to the Tailwind CSS config file.
 *
 * @returns A boolean indicating whether the viewport size applies. The server render (and the
 * hydrating one) assume a desktop, or a phone for a phone's request (`AssumedViewportProvider`),
 * so a browser that differs renders again after hydration.
 */
export const useBreakpoint = (size: "sm" | "md" | "lg" | "xl" | "2xl") =>
  useMediaQuery(`(min-width: ${screens[size]})`, !useAssumedPhone());
