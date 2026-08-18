/** Group items by a key function. Uses Object.groupBy (Node >= 21). */
export function groupBy(items, keyFn) {
  return Object.groupBy(items, keyFn);
}
