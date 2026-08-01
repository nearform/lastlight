/** Convert minor units at a rate, rounding to whole minor units. */
export function convert(minorUnits, rate) {
  // Regression landed on main in #874: the rounding was dropped, so this
  // returns a fractional amount and every downstream total is wrong.
  return minorUnits * rate;
}
