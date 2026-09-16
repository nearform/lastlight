import clsx from "clsx";

/**
 * One GitHub label, in the label's own colour.
 *
 * GitHub ships `color` as a BARE six-digit hex ("d73a4a") — no leading `#` —
 * and occasionally as an empty string. Anything that isn't six hex digits
 * falls back to the neutral chip rather than producing `background: #` and a
 * chip that silently disappears into the card.
 *
 * Unknown labels render as-is: the operator names these, and a vocabulary
 * this component knew about would be wrong the first time someone added one.
 */
export function LabelChip({
  name,
  color,
  description,
}: {
  name: string;
  color?: string;
  description?: string;
}) {
  const hex = normalizeHex(color);
  return (
    <span
      title={description || name}
      className={clsx(
        "inline-flex max-w-[12rem] items-center truncate rounded-full px-1.5 py-px text-[10px] font-medium leading-4",
        !hex && "border border-hairline text-muted",
      )}
      style={
        hex
          ? {
              // SOLID, with the ink picked by the label's own luminance — what
              // GitHub itself renders, and the only scheme that is correct
              // without knowing the theme.
              //
              // The wash this replaced could not be: a chip's background was a
              // 30% mix of the label over the CARD, so its lightness depended on
              // a colour this component never sees. A light label like
              // `enhancement` (#a2eeef) washed over a dark card produced a DARK
              // chip, and ink chosen from the label's own (light) luminance came
              // out dark too — grey on grey, at 10px. Filling with the label
              // colour makes the background the one thing we can measure, so the
              // contrast decision is sound in both themes and for every hex
              // GitHub might send.
              backgroundColor: hex,
              color: onWash(hex),
              border: `1px solid color-mix(in oklab, ${hex} 80%, ${onWash(hex)})`,
            }
          : undefined
      }
    >
      {name}
    </span>
  );
}

/** `"d73a4a"` / `"#d73a4a"` → `"#d73a4a"`; anything else → `null`. */
function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

/**
 * The ink colour for a wash of `hex` — near-black on a light label, near-white
 * on a dark one.
 *
 * Exported because it is the whole of the contrast decision, and a pure
 * function of one string: the alternative is eyeballing chips in two themes and
 * hoping. The threshold is WCAG relative luminance at 0.45 rather than a naive
 * average of the channels, because the eye is far more sensitive to green than
 * to blue — `#0000ff` averages light and reads black.
 */
export function onWash(hex: string): string {
  return relativeLuminance(hex) < 0.45 ? "#f2f5f8" : "#10141a";
}

/** WCAG relative luminance for a `#rrggbb` string. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
