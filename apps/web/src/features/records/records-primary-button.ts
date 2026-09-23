/**
 * Black solid fill for Records primary actions.
 * `color="primary"` alone paints brand purple; weekly-report Send already overrides with
 * `bg-primary-solid` (neutral-950). Share that override so every blue Records primary matches.
 */
export const RECORDS_PRIMARY_BUTTON_CLASSNAME =
  "bg-primary-solid text-white ring-transparent hover:bg-primary-solid hover:text-white data-loading:bg-primary-solid";

/** Same black fill, with a full-white leading icon (primary defaults icons to white/60). */
export const RECORDS_AI_PRIMARY_BUTTON_CLASSNAME = `${RECORDS_PRIMARY_BUTTON_CLASSNAME} *:data-icon:text-white hover:*:data-icon:text-white`;
