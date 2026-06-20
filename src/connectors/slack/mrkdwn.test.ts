import { describe, it, expect } from 'vitest';
import { markdownToSlackMrkdwn } from './mrkdwn.js';

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
  });
});
