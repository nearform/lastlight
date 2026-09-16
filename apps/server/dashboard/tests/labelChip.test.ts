/**
 * `LabelChip` — the GitHub colour normalisation.
 *
 * GitHub ships `color` as a BARE six-digit hex ("d73a4a"), with no leading `#`,
 * and occasionally as an empty string. Getting that wrong produces
 * `background: #` — a chip that silently disappears into the card rather than
 * failing loudly — so the normalisation and its fallback are worth pinning.
 *
 * The component is a plain function of its props with no hooks, so it is called
 * directly and the returned element inspected: no DOM, no renderer.
 */
import { describe, it, expect } from "vitest";
import { LabelChip } from "../src/components/board/LabelChip";

interface ChipProps {
  className?: string;
  style?: { backgroundColor?: string; color?: string; border?: string };
  title?: string;
  children?: unknown;
}

function chip(props: { name: string; color?: string; description?: string }): ChipProps {
  return (LabelChip(props) as { props: ChipProps }).props;
}

describe("LabelChip colour", () => {
  it("fills with GitHub's bare six-hex colour, adding the `#`", () => {
    const { style } = chip({ name: "bug", color: "d73a4a" });
    // SOLID: the label's own colour is the background, and the ink is picked
    // from it. The chip used to be a wash of the label over the card, which
    // made its lightness depend on a colour this component never sees.
    expect(style?.backgroundColor).toBe("#d73a4a");
    expect(style?.color).toBe("#f2f5f8");
  });

  it("accepts an already-prefixed value without doubling the `#`", () => {
    expect(chip({ name: "bug", color: "#d73a4a" }).style?.backgroundColor).toBe("#d73a4a");
  });

  it("accepts uppercase hex as-is", () => {
    expect(chip({ name: "bug", color: "D73A4A" }).style?.backgroundColor).toBe("#D73A4A");
  });

  it("picks ink by LUMINANCE, so a pale label is still readable", () => {
    // The bug this replaced: `enhancement` ships `#a2eeef`, and choosing ink
    // from the label's own hue gave pale cyan on a paler cyan wash — invisible
    // at 10px. A light fill must take dark ink and a dark fill light ink,
    // whatever the theme behind it.
    expect(chip({ name: "enhancement", color: "a2eeef" }).style?.color).toBe("#10141a");
    expect(chip({ name: "bug", color: "b60205" }).style?.color).toBe("#f2f5f8");
    // Green is weighted far above blue in relative luminance, so a naive
    // channel average gets these two the wrong way round.
    expect(chip({ name: "lime", color: "00ff00" }).style?.color).toBe("#10141a");
    expect(chip({ name: "blue", color: "0000ff" }).style?.color).toBe("#f2f5f8");
  });

  it("tolerates surrounding whitespace", () => {
    expect(chip({ name: "bug", color: "  d73a4a  " }).style?.backgroundColor).toBe("#d73a4a");
  });

  it("falls back to the neutral chip for a colour that is not six hex digits", () => {
    for (const color of ["", "   ", "#", "fff", "d73a4ab", "red", "zzzzzz", "#12345g"]) {
      const { style, className } = chip({ name: "bug", color });
      expect(style, `color=${JSON.stringify(color)}`).toBeUndefined();
      expect(className).toContain("border-hairline");
      expect(className).toContain("text-muted");
    }
  });

  it("falls back for a missing or non-string colour", () => {
    expect(chip({ name: "bug" }).style).toBeUndefined();
    expect(chip({ name: "bug", color: undefined }).style).toBeUndefined();
    expect(chip({ name: "bug", color: 16_724_530 as unknown as string }).style).toBeUndefined();
  });

  it("never emits the neutral border classes when a colour applied", () => {
    // The two treatments are exclusive: a coloured chip draws its own border
    // via `style`, and keeping the hairline class too would double it.
    const { className } = chip({ name: "bug", color: "d73a4a" });
    expect(className).not.toContain("border-hairline");
  });
});

describe("LabelChip text", () => {
  it("renders the operator's label name as-is", () => {
    expect(chip({ name: "ready-for-agent", color: "0e8a16" }).children).toBe("ready-for-agent");
  });

  it("titles the chip with its description, falling back to the name", () => {
    expect(chip({ name: "bug", description: "Something is broken" }).title).toBe("Something is broken");
    expect(chip({ name: "bug" }).title).toBe("bug");
    expect(chip({ name: "bug", description: "" }).title).toBe("bug");
  });
});
