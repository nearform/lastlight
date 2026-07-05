// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://lastlight.dev',
  integrations: [
    sitemap({
      // /docs/ and /evals/ are meta-refresh redirects to their intro pages, not real pages
      filter: (page) => !page.endsWith('/docs/') && !page.endsWith('/evals/'),
    }),
  ],
});
