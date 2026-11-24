// Safe, dependency-free markdown for the assistant's answer bubbles. The brain's text is
// untrusted model output, so there is deliberately NO HTML parse step and NO
// dangerouslySetInnerHTML — every node this file emits is a React element whose children
// are plain strings (React escapes them), which makes `<img onerror=…>` in the text
// renderable only AS text. The one injection-adjacent sink is <a href>, gated below to
// URLs that parse with an explicit http:/https: protocol; any other scheme
// (javascript:/data:/vbscript:/relative) stays literal text. Block structure
// (fences/headings/lists/paragraphs) is line-based; inline styling is a regex tokenizer
// per text run, same text→ReactNode[] shape as AssistantDock's highlightCommand.
//
// The bubble (.amsg) keeps white-space:pre-wrap, so single newlines INSIDE a paragraph
// still break lines; blank lines are consumed here as paragraph separators and the
// inter-block gap comes from .md-p margins — never from whitespace text nodes, which is
// what keeps pre-wrap from double-spacing paragraphs.

import type { ReactNode } from 'react';

/** The <a href> gate — the whole XSS defense: only a URL that parses to an absolute
 *  http:/https: target earns a link. `new URL` has no base on purpose, so relative and
 *  malformed inputs throw and are refused along with every non-http scheme. */
function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Inline pass over one text run: `code` | **bold** | *italic* | [label](url). Single
 *  level — token content stays a raw string child, and \n is excluded from every token so
 *  styling never swallows a pre-wrap line break. */
function renderInline(text: string): ReactNode[] {
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]*?)\]\(([^)\s]+)\)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [whole, code, bold, ital, label, url] = m;
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (code !== undefined) {
      nodes.push(<code key={`c${k++}`} className="md-code mono">{code}</code>);
    } else if (bold !== undefined) {
      nodes.push(<strong key={`b${k++}`}>{bold}</strong>);
    } else if (ital !== undefined) {
      nodes.push(<em key={`i${k++}`}>{ital}</em>);
    } else if (url !== undefined) {
      const href = safeHttpUrl(url);
      if (href) {
        nodes.push(
          <a key={`a${k++}`} className="md-a" href={href} target="_blank" rel="noopener noreferrer">
            {label ?? ''}
          </a>,
        );
      } else {
        nodes.push(whole); // refused scheme — the literal [label](url) text, unstyled
      }
    }
    last = m.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** The bubble-body role gate: ONLY the assistant's answer goes through the markdown pass.
 *  User text must come back as the literal string — styling a user's `**` would silently
 *  misquote them — and system rows never reach this span (they render through the jv-sys
 *  sanitize path). Exported pure so the gate itself is unit-testable; the dock's msg span
 *  renders through THIS, never renderMarkdown directly. */
export function renderRowBody(role: 'user' | 'assistant' | 'system', text: string): ReactNode[] | string {
  return role === 'assistant' ? renderMarkdown(text) : text;
}

/** Render an assistant answer to a list of block elements (headings, fenced code, lists,
 *  paragraphs). The output contains NO bare text nodes at the top level — see the header
 *  note on pre-wrap — and every leaf child is a string. */
export function renderMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let k = 0;
  let i = 0;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    // Rejoin with the original single newlines — pre-wrap renders them as line breaks.
    out.push(<div key={`p${k++}`} className="md-p">{renderInline(para.join('\n'))}</div>);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      // Fence: opening line (language tag discarded) through the closing ``` or EOF.
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++; // past the closing fence (harmless at EOF)
      out.push(<pre key={`f${k++}`} className="md-pre mono">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      out.push(<div key={`h${k++}`} className={`md-h${(h[1] ?? '#').length}`}>{renderInline(h[2] ?? '')}</div>);
      i++;
      continue;
    }
    const ordered = /^\s*\d+\.\s+/.test(line);
    if (ordered || /^\s*[-*]\s+/.test(line)) {
      // A run of same-marker lines becomes one list; a blank line or other marker ends it.
      flushPara();
      const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*]\s+(.*)$/;
      const items: ReactNode[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = itemRe.exec(lines[i] ?? '')) !== null) {
        items.push(<li key={`l${k++}`}>{renderInline(m[1] ?? '')}</li>);
        i++;
      }
      out.push(
        ordered ? (
          <ol key={`o${k++}`} className="md-ol">{items}</ol>
        ) : (
          <ul key={`u${k++}`} className="md-ul">{items}</ul>
        ),
      );
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara(); // blank line = paragraph separator, consumed (never a text node)
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}
