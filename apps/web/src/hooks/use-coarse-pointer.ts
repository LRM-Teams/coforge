import { useAssumedPhone } from "./assumed-viewport";
import { useMediaQuery } from "./use-media-query";

const QUERY = "(hover: none), (any-pointer: coarse)";

/**
 * True on touch-first devices — no hover capability, or a coarse primary pointer. This is
 * the JS counterpart of the `[@media(hover:none)]` / `[@media(any-pointer:coarse)]` rules
 * used in CSS, for behavior that cannot be expressed in styles alone. The server render (and the
 * hydrating one) assume a mouse, or touch for a phone's request (`AssumedViewportProvider`), so a
 * device that differs renders again after hydration.
 */
export const useCoarsePointer = () => useMediaQuery(QUERY, useAssumedPhone());
