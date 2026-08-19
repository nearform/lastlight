// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://lastlight.dev',
  // Astro 7 changed the default to 'jsx', which strips the whitespace between
  // inline elements — that ate the spaces around our inline links and <code>
  // spans (", <a>" became ",<a>"). Keep the Astro 6 behaviour.
  compressHTML: true,
  markdown: {
    // Fenced code blocks in the content collections (every /spec/* page) are
    // highlighted by Shiki. Astro's default is a single `github-dark` theme,
    // which bakes `background-color:#24292e` and a light ink into an INLINE
    // style — so those blocks stayed dark under the light theme while the
    // hand-written <pre> blocks on /docs followed `--navy` and went light.
    // Worse, the layouts' `pre code { color: var(--text) }` beat the inline
    // ink, leaving near-black text on that dark slab (1.08:1, unreadable).
    //
    // A theme PAIR plus `defaultColor: false` emits `--shiki-light` /
    // `--shiki-dark` custom properties per token instead of a baked colour,
    // and emits no inline background at all — so the existing
    // `.spec-article pre { background: var(--navy) }` rule finally applies and
    // the highlighting follows `data-theme`. See the `.astro-code` rules in
    // BaseLayout.astro, which are the other half of this.
    //
    // The light theme is the HIGH-CONTRAST variant on purpose. Plain
    // `github-light` is tuned for a pure-white page, and we render these
    // blocks on `--navy` (#EEF1F4, a soft grey) to match the hand-written
    // <pre> blocks — enough of a drop to put its keyword, string and comment
    // tokens at 3.1–4.3:1. The high-contrast palette clears AA on that same
    // surface for every token but comments (4.44), which are muted by design.
    shikiConfig: {
      themes: { light: 'github-light-high-contrast', dark: 'github-dark' },
      defaultColor: false,
    },
  },
  integrations: [
    sitemap({
      // /docs/ and /evals/ are meta-refresh redirects to their intro pages, not real pages.
      // /spec/* is noindex (see BaseLayout's `noindex` prop) — listing a noindex
      // page in the sitemap sends Google two contradictory signals, so drop it.
      filter: (page) =>
        !page.endsWith('/docs/') &&
        !page.endsWith('/evals/') &&
        !new URL(page).pathname.startsWith('/spec'),
    }),
  ],
});
