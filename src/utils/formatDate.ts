/**
 * Format a Date into a string in the form `YYYY, MM, DD`.
 *
 * This function uses the local time zone via Date#getFullYear/#getMonth/#getDate.
 * It throws a TypeError if the provided Date is invalid (e.g. `new Date(NaN)`).
 */
export function formatDateYYYYMMDD(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("formatDateYYYYMMDD expected a valid Date instance");
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}, ${month}, ${day}`;
}
