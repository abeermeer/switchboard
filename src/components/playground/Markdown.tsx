import { Fragment } from 'react';

/**
 * A small purpose-built markdown renderer.
 *
 * It covers what an LLM actually emits — fenced code, headings, lists, bold,
 * italic and inline code — and nothing else. A full markdown pipeline would be
 * a dependency and a bundle cost for a feature that renders model output in a
 * side panel.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre
          key={key++}
          className="my-2 overflow-x-auto rounded-sb border border-line bg-surface-2 px-3 py-2 font-mono text-[0.6875rem] leading-relaxed"
        >
          {lang.length > 0 && <div className="mb-1 text-[0.625rem] text-faint">{lang}</div>}
          <code className="text-ink">{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Headings
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      blocks.push(
        <p
          key={key++}
          className={
            level <= 2
              ? 'mb-1 mt-3 text-sm font-semibold text-ink'
              : 'mb-1 mt-2 text-xs font-semibold text-ink'
          }
        >
          {inline(heading[2] ?? '')}
        </p>,
      );
      i += 1;
      continue;
    }

    // List runs
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={key++}
          className={`my-1.5 space-y-0.5 pl-4 text-xs leading-relaxed text-ink ${
            ordered ? 'list-decimal' : 'list-disc'
          }`}
        >
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Paragraph run
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim().length > 0 &&
      !(lines[i] ?? '').trimStart().startsWith('```') &&
      !/^#{1,4}\s/.test(lines[i] ?? '') &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? '')
    ) {
      paragraph.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push(
      <p key={key++} className="my-1.5 text-xs leading-relaxed text-ink">
        {inline(paragraph.join(' '))}
      </p>,
    );
  }

  return <div>{blocks}</div>;
}

/** Bold, italic and inline code within a line. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={index}
          className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.6875rem] text-accent"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={index} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
