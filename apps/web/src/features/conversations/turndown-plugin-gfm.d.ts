// turndown-plugin-gfm ships no types of its own and has no @types package (registry 404); declare
// the one plugin entry point selection-copy.ts uses.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export const gfm: TurndownService.Plugin;
}
