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
  integrations: [
    sitemap({
      // /docs/ and /evals/ are meta-refresh redirects to their intro pages, not real pages
      filter: (page) => !page.endsWith('/docs/') && !page.endsWith('/evals/'),
    }),
  ],
});
