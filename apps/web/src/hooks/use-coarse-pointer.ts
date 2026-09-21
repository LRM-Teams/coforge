import { useEffect, useState } from "react";

const QUERY = "(hover: none), (any-pointer: coarse)";

/**
 * True on touch-first devices — no hover capability, or a coarse primary pointer. This is
 * the JS counterpart of the `[@media(hover:none)]` / `[@media(any-pointer:coarse)]` rules
 * used in CSS, for behavior that cannot be expressed in styles alone.
 */
export const useCoarsePointer = () => {
  const [matches, setMatches] = useState(
    typeof window !== "undefined" ? window.matchMedia(QUERY).matches : false,
  );

  useEffect(() => {
    const query = window.matchMedia(QUERY);
    setMatches(query.matches);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return matches;
};
