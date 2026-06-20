// Python format-spec helpers, so JS produces byte-identical user-facing strings
// to the original f-strings in recommendation.py. Rounding uses pyround (correct
// rounding of the true double); grouped output uses Intl for the thousands
// separators. Exact half-ties (which don't occur in float-derived dollar/percent
// values) are the only place these can differ from CPython's round-half-even.

import { pyround } from "./series.js";

const GROUP = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const GROUP2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// f"{x:.1f}"
export const f1 = (x) => pyround(x, 1).toFixed(1);
// f"{x:.0f}"
export const f0 = (x) => String(pyround(x, 0));
// f"{x:,.0f}"  — thousands-grouped, no decimals
export const c0 = (x) => GROUP.format(pyround(x, 0));
// f"{x:,.2f}"  — thousands-grouped, two decimals
export const c2 = (x) => GROUP2.format(pyround(x, 2));
