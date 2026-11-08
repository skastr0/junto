/**
 * How big a mail's sender stamp can get. A leaf module: the region schema and
 * the mail stamp both read it, and it imports nothing, so neither import
 * cycle through the model can leave these unset while a module loads.
 */

/** The longest name a region may have, in characters. */
export const REGION_NAME_MAX = 80;

/** The most regions a mail's stamp names: the innermost ones, still outermost first. */
export const MAIL_SENDER_REGIONS_MAX = 16;
