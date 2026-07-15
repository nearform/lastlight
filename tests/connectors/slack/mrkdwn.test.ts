import { describe, it, expect } from 'vitest';
import {
  hasMarkdownImage,
  markdownToSlackBlocks,
  markdownToSlackMrkdwn,
} from '#src/connectors/slack/mrkdwn.js';

describe('markdownToSlackMrkdwn', () => {
  it('converts h1 headers to bold', () => {
    expect(markdownToSlackMrkdwn('# Hello World')).toBe('*Hello World*');
  });

  it('converts h2 headers to bold', () => {
    expect(markdownToSlackMrkdwn('## Section Title')).toBe('*Section Title*');
  });

  it('converts h6 headers to bold', () => {
    expect(markdownToSlackMrkdwn('###### Deep Header')).toBe('*Deep Header*');
  });

  it('converts **bold** to *bold*', () => {
    expect(markdownToSlackMrkdwn('This is **bold** text')).toBe('This is *bold* text');
  });

  it('converts __bold__ to *bold*', () => {
    expect(markdownToSlackMrkdwn('This is __bold__ text')).toBe('This is *bold* text');
  });

  it('converts ~~strikethrough~~ to ~strikethrough~', () => {
    expect(markdownToSlackMrkdwn('This is ~~struck~~ text')).toBe('This is ~struck~ text');
  });

  it('converts [text](url) links to <url|text>', () => {
    expect(markdownToSlackMrkdwn('[GitHub](https://github.com)')).toBe('<https://github.com|GitHub>');
  });

  it('converts ![alt](url) images to <url|alt>', () => {
    expect(markdownToSlackMrkdwn('![logo](https://example.com/img.png)')).toBe('<https://example.com/img.png|logo>');
  });

  it('converts --- horizontal rule to ———', () => {
    expect(markdownToSlackMrkdwn('---')).toBe('———');
  });

  it('converts *** horizontal rule to ———', () => {
    expect(markdownToSlackMrkdwn('***')).toBe('———');
  });

  it('preserves fenced code blocks', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain('const x = 1;');
    // Code content not transformed
    expect(result).not.toContain('*typescript*');
  });

  it('preserves inline code', () => {
    const input = 'Use `npm install` to install';
    const result = markdownToSlackMrkdwn(input);
    expect(result).toBe('Use `npm install` to install');
  });

  it('does not transform bold markers inside code blocks', () => {
    const input = '```\n**not bold**\n```';
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain('**not bold**');
  });

  it('handles combined transformations', () => {
    const input = '## Title\n\nThis is **bold** and ~~struck~~.\n\n[Link](https://example.com)';
    const result = markdownToSlackMrkdwn(input);
    expect(result).toContain('*Title*');
    expect(result).toContain('*bold*');
    expect(result).toContain('~struck~');
    expect(result).toContain('<https://example.com|Link>');
  });

  it('images before links so images are processed correctly', () => {
    const input = '![alt](https://img.example.com) and [text](https://link.example.com)';
    const result = markdownToSlackMrkdwn(input);
    expect(result).toBe('<https://img.example.com|alt> and <https://link.example.com|text>');
  });

  describe('GFM tables', () => {
    it('renders a table as an aligned monospace code block', () => {
      const input = [
        '| Feature | Last Light | Eve |',
        '|---------|-----------|-----|',
        '| Scope | maintenance agent | framework |',
        '| Hosting | self-hosted | managed |',
      ].join('\n');
      const result = markdownToSlackMrkdwn(input);
      // Wrapped in a code block so Slack renders it fixed-width.
      expect(result.startsWith('```')).toBe(true);
      expect(result.trimEnd().endsWith('```')).toBe(true);
      // Header present, GFM delimiter pipes gone.
      expect(result).toContain('Feature');
      expect(result).toContain('Last Light');
      expect(result).not.toContain('|');
      // The header label and the row value below it start at the same column.
      const lines = result.split('\n');
      const headerLine = lines.find((l) => l.includes('Last Light'))!;
      const rowLine = lines.find((l) => l.includes('maintenance agent'))!;
      expect(rowLine.indexOf('maintenance agent')).toBe(headerLine.indexOf('Last Light'));
    });

    it('aligns columns to the widest cell', () => {
      const input = '| A | Bbbbb |\n|---|---|\n| ccccc | d |';
      const result = markdownToSlackMrkdwn(input);
      // "A" padded to width of "ccccc"; two-space gutter between columns.
      expect(result).toContain('A      Bbbbb');
      expect(result).toContain('ccccc  d');
    });

    it('strips inline markdown inside cells', () => {
      const input = '| Name | Link |\n|---|---|\n| **bold** | [docs](https://x.io) |';
      const result = markdownToSlackMrkdwn(input);
      expect(result).toContain('bold');
      expect(result).not.toContain('**bold**');
      expect(result).toContain('docs (https://x.io)');
    });

    it('leaves pipe characters inside fenced code blocks alone', () => {
      const input = '```\n| not | a | table |\n|---|---|---|\n```';
      const result = markdownToSlackMrkdwn(input);
      expect(result).toContain('| not | a | table |');
    });

    it('only converts the table, leaving surrounding prose intact', () => {
      const input = 'Here is the comparison:\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n\nThanks!';
      const result = markdownToSlackMrkdwn(input);
      expect(result).toContain('Here is the comparison:');
      expect(result).toContain('Thanks!');
      expect(result).toContain('```');
    });

    it('truncates an over-wide cell with an ellipsis and keeps alignment', () => {
      const long = 'x'.repeat(40); // exceeds the 28-char column cap
      const input = `| K | Detail | Z |\n|---|---|---|\n| a | ${long} | c |`;
      const result = markdownToSlackMrkdwn(input);
      // Still a monospace block (3 columns, overall width stays in budget).
      expect(result.startsWith('```')).toBe(true);
      // The 40-char cell is truncated to 27 chars + an ellipsis.
      expect(result).not.toContain(long);
      expect(result).toContain('x'.repeat(27) + '…');
      // Header label and its column value still start at the same offset.
      const lines = result.split('\n');
      const headerLine = lines.find((l) => l.includes('Detail'))!;
      const rowLine = lines.find((l) => l.includes('…'))!;
      expect(rowLine.indexOf('x')).toBe(headerLine.indexOf('Detail'));
    });

    it('keeps a wide multi-column table within the width budget', () => {
      const cell = (n: number) => `${n}`.repeat(30); // each column wants 30 chars
      const input = [
        '| C1 | C2 | C3 | C4 |',
        '|---|---|---|---|',
        `| ${cell(1)} | ${cell(2)} | ${cell(3)} | ${cell(4)} |`,
      ].join('\n');
      const result = markdownToSlackMrkdwn(input);
      const body = result.split('\n').filter((l) => l !== '```');
      for (const line of body) expect(line.length).toBeLessThanOrEqual(72);
    });

    it('falls back to a *label*: value list for a too-wide 2-column table', () => {
      const long = 'y'.repeat(70);
      const input = `| Field | Value |\n|---|---|\n| Name | ${long} |`;
      const result = markdownToSlackMrkdwn(input);
      // Not a code block — stacked key/value mrkdwn instead.
      expect(result).not.toContain('```');
      expect(result).toContain(`*Name*: ${long}`);
    });

    it('elides rows past the inline cap with a summary line', () => {
      const rows = Array.from({ length: 35 }, (_, i) => `| r${i} | v${i} |`);
      const input = ['| K | V |', '|---|---|', ...rows].join('\n');
      const result = markdownToSlackMrkdwn(input);
      expect(result).toContain('… (5 more rows)');
      // The first row is present, a row past the cap is not.
      expect(result).toContain('r0');
      expect(result).not.toContain('r34');
    });
  });

  describe('markdownToSlackBlocks (inline images)', () => {
    it('detects markdown images', () => {
      expect(hasMarkdownImage('see ![logo](https://x/y.png)')).toBe(true);
      expect(hasMarkdownImage('just [a link](https://x)')).toBe(false);
      expect(hasMarkdownImage('plain text')).toBe(false);
    });

    it('promotes an image to an image block with text sections around it', () => {
      const md = 'Before **bold** text\n\n![the logo](https://ex.com/logo.png)\n\nafter';
      const blocks = markdownToSlackBlocks(md) as any[];
      const image = blocks.find((b) => b.type === 'image');
      expect(image).toBeTruthy();
      expect(image.image_url).toBe('https://ex.com/logo.png');
      expect(image.alt_text).toBe('the logo');
      // Surrounding prose is rendered as section blocks (bold converted).
      const sections = blocks.filter((b) => b.type === 'section');
      expect(sections.length).toBe(2);
      expect(sections[0].text.text).toContain('*bold*');
      expect(sections[1].text.text).toContain('after');
    });

    it('falls back to the URL for empty alt text', () => {
      const blocks = markdownToSlackBlocks('![](https://ex.com/a.png)') as any[];
      expect(blocks[0].type).toBe('image');
      expect(blocks[0].alt_text).toBe('https://ex.com/a.png');
    });

    it('leaves a non-http image URL as text (no image block)', () => {
      const blocks = markdownToSlackBlocks('![x](/relative/path.png)') as any[];
      expect(blocks.some((b) => b.type === 'image')).toBe(false);
      expect(blocks[0].type).toBe('section');
    });

    it('handles multiple images in one message', () => {
      const md = '![a](https://x/1.png) middle ![b](https://x/2.png)';
      const blocks = markdownToSlackBlocks(md) as any[];
      const images = blocks.filter((b) => b.type === 'image');
      expect(images.map((i) => i.image_url)).toEqual(['https://x/1.png', 'https://x/2.png']);
    });
  });
});
