import type { APIRoute } from 'astro';
import { docsNav } from '../data/docs-nav';

const SITE_PAGES: Array<{ path: string; label: string; description?: string }> = [
  { path: '/', label: 'Home', description: 'Overview of what Last Light is and what it does' },
  { path: '/how-it-works', label: 'How it works', description: 'Architecture, agent roles, and the workflow engine' },
  { path: '/run-it', label: 'Run it', description: 'Quick path to get Last Light running against your own repos' },
  { path: '/faq', label: 'FAQ', description: 'Common questions about cost, safety, and supported runtimes' },
];

const EXTERNAL: Array<{ url: string; label: string; description?: string }> = [
  { url: 'https://github.com/nearform/lastlight', label: 'GitHub repository', description: 'Source code, issues, and releases' },
  { url: 'https://github.com/users/cliftonc/projects/4', label: 'Roadmap', description: 'GitHub Project tracking planned work' },
  { url: 'https://cliftonc.nl/blog/the-harness-is-the-product.md', label: 'The harness is the product', description: 'Author\'s blog post explaining where Last Light fits in the broader agent-harness landscape' },
];

export const GET: APIRoute = async ({ site }) => {
  const origin = (site?.origin ?? 'https://lastlight.dev').replace(/\/$/, '');

  const lines: string[] = [
    '# Last Light',
    '',
    "> An open-source agent that keeps the lights on in GitHub repos you've moved on from.",
    '',
    'Last Light is a YAML-driven workflow engine that runs an agentic-pi-powered AI agent in per-phase gondolin micro-VMs (or Docker containers) with downscoped GitHub tokens. Chat runs in-process via `@earendil-works/pi-ai`. It triages issues, reviews PRs, fixes small things, runs scheduled repo-health reports, and chats over Slack — handing work between Architect / Executor / Reviewer roles and pausing at approval gates the maintainer can resume from a comment. The harness is the product: the workflows are YAML you can fork and edit; the agent runtime, sandboxing, and policy gates are the engine.',
    '',
    '## Site',
    '',
    ...SITE_PAGES.map((p) => {
      const desc = p.description ? `: ${p.description}` : '';
      const mdPath = p.path === '/' ? '/index.md' : `${p.path}.md`;
      return `- [${p.label}](${origin}${mdPath})${desc}`;
    }),
    '',
  ];

  for (const section of docsNav) {
    lines.push(`## Docs: ${section.title}`);
    lines.push('');
    for (const item of section.items) {
      lines.push(`- [${item.label}](${origin}/docs/${item.slug}.md)`);
    }
    lines.push('');
  }

  lines.push('## External');
  lines.push('');
  for (const ext of EXTERNAL) {
    const desc = ext.description ? `: ${ext.description}` : '';
    lines.push(`- [${ext.label}](${ext.url})${desc}`);
  }
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
