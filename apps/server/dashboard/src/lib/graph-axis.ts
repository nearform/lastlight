/**
 * Which way a workflow graph flows.
 *
 * Direction used to be baked into three separate layers — the x/y arithmetic in
 * each layout, the `sourceHandle`/`targetHandle` literals on every edge, and
 * the connector dots drawn on the card — so turning the pipeline vertical meant
 * inverting the same idea in three places and hoping they agreed. It lives here
 * instead, expressed once against two abstract axes:
 *
 *   MAIN  — along the pipeline, phase after phase.
 *   CROSS — across it: the branches of a fan-out, the iterations of a loop,
 *           the sibling rows of a DAG column.
 *
 * Both views run `TB` today. `LR` stays because it is one expression per
 * function and it is what keeps this file readable as a statement about
 * direction rather than a pile of swapped literals.
 */
export type FlowDir = "LR" | "TB";

/**
 * Card width, shared by both views — they render literally the same card.
 * Wider than the text needs, deliberately: phase labels are sentences, and at a
 * narrow width each wraps to a different number of lines, so every card in a
 * row came out a different height.
 */
export const NODE_WIDTH = 190;

/** Turn a (main, cross) position into the canvas position for `dir`. */
export function place(dir: FlowDir, main: number, cross: number): { x: number; y: number } {
  return dir === "TB" ? { x: cross, y: main } : { x: main, y: cross };
}

/** Turn a (main, cross) extent into a canvas width/height for `dir`. */
export function extent(dir: FlowDir, main: number, cross: number): { width: number; height: number } {
  return dir === "TB" ? { width: cross, height: main } : { width: main, height: cross };
}

/** The handle ids an edge ALONG the pipeline attaches to. */
export function mainHandles(dir: FlowDir): { source: string; target: string } {
  return dir === "TB" ? { source: "bottom", target: "top" } : { source: "right", target: "left" };
}

/** The handle ids an edge ACROSS it attaches to — loop iteration → iteration. */
export function crossHandles(dir: FlowDir): { source: string; target: string } {
  return dir === "TB" ? { source: "right", target: "left" } : { source: "bottom", target: "top" };
}

// ── Card height ───────────────────────────────────────────────────────────
// Flowing top-to-bottom, the pitch from one phase to the next IS the card's
// height, and these cards are not a uniform height: a phase with three skill
// tags is twice a bare one, and a two-line label adds another row. A fixed
// pitch therefore either overlaps the tall cards or leaves a lake of dead
// space after every short one — which is exactly what a single constant did.
//
// So the height is ESTIMATED from the card's content, in the same spirit as
// the container-geometry constants: a few px over is free, under costs an
// overlap, and nothing here needs to be exact because the layout only has to
// keep cards apart, not align them to anything.

/** Header strip: icon + label, one line. */
const HEADER_LINE = 38;
/** Each additional wrapped line of the label. */
const LABEL_LINE = 16;
/** One line of body text — the phase id, a summary line, the meta line. */
const BODY_LINE = 18;
/** A tag chip row (`skill: …`, `prompt`) — taller than text, it is a pill. */
const TAG_ROW = 26;
/** Body padding, once, when there is a body at all. */
const BODY_PAD = 12;
/** The return arc a looping phase hangs below itself. */
const LOOP_ARC = 14;

/** Roughly how many characters of the label fit on one line of a card. */
const LABEL_CHARS_PER_LINE = 22;

/** How many lines a label wraps to at {@link NODE_WIDTH}. Capped — the card
 *  itself clamps, so a pathological label must not push the whole graph open. */
export function labelLines(label: string): number {
  return Math.min(3, Math.max(1, Math.ceil(label.length / LABEL_CHARS_PER_LINE)));
}

/** Approximate rendered height of a phase card with the given content. */
export function cardHeight(parts: {
  label: string;
  /** Lines of plain body text: the phase id, a summary, the time·duration line. */
  bodyLines?: number;
  /** Tag chips, each on its own row. */
  tagRows?: number;
  /** The phase draws the loop return arc below itself. */
  loops?: boolean;
}): number {
  const bodyLines = parts.bodyLines ?? 0;
  const tagRows = parts.tagRows ?? 0;
  const hasBody = bodyLines > 0 || tagRows > 0;
  return (
    HEADER_LINE +
    (labelLines(parts.label) - 1) * LABEL_LINE +
    (hasBody ? BODY_PAD + bodyLines * BODY_LINE + tagRows * TAG_ROW : 0) +
    (parts.loops ? LOOP_ARC : 0)
  );
}
