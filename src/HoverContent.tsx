import { type Component, createSignal, createEffect, For } from 'solid-js';
import { Marked } from 'marked';
import { getHighlighter, loadLang, escapeHtml, type Highlighter } from './highlighter';

// LSP Hover content types per the spec:
// - MarkupContent: { kind: "markdown" | "plaintext", value: string }
// - MarkedString: string | { language: string, value: string }
// - MarkedString[]

/**
 * Render hover markdown to HTML.
 * Code blocks are rendered by shiki for syntax highlighting;
 * everything else goes through `marked` for proper inline markdown
 * (bold @param, inline code, links, etc.)
 */

async function renderMarkdown(
  md: string,
  highlighter: Highlighter,
  theme: string,
): Promise<string> {
  // Collect code block languages so we can pre-load them
  const codeBlockRe = /^```(\w+)\s*$/gm;
  let m;
  const langs = new Set<string>();
  while ((m = codeBlockRe.exec(md)) !== null) {
    langs.add(m[1]);
  }
  await Promise.all([...langs].map(l => loadLang(highlighter, l)));

  const marked = new Marked({
    async: false,
    gfm: true,
    breaks: false,
  });

  const renderer = {
    code({ text, lang }: { text: string; lang?: string | null }) {
      if (lang) {
        const loaded = highlighter.getLoadedLanguages().includes(lang as never);
        if (loaded) {
          return highlighter.codeToHtml(text, { lang, theme });
        }
      }
      return `<pre class="hover-code-fallback"><code>${escapeHtml(text)}</code></pre>`;
    },
  };

  marked.use({ renderer });

  return marked.parse(md) as string;
}

function normalizeToMarkdownParts(contents: unknown): string[] {
  if (contents == null) return [];

  // MarkupContent: { kind, value }
  if (typeof contents === 'object' && !Array.isArray(contents) && 'kind' in (contents as object)) {
    const mc = contents as { kind: string; value: string };
    if (mc.kind === 'plaintext') {
      return [escapeHtml(mc.value)];
    }
    return [mc.value];
  }

  // MarkedString as string (treated as markdown)
  if (typeof contents === 'string') {
    return [contents];
  }

  // MarkedString as { language, value } (a code block)
  if (typeof contents === 'object' && !Array.isArray(contents) && 'language' in (contents as object)) {
    const ms = contents as { language: string; value: string };
    return ['```' + ms.language + '\n' + ms.value + '\n```'];
  }

  // MarkedString[]
  if (Array.isArray(contents)) {
    const parts: string[] = [];
    for (const item of contents) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (typeof item === 'object' && item !== null && 'language' in item) {
        const ms = item as { language: string; value: string };
        parts.push('```' + ms.language + '\n' + ms.value + '\n```');
      }
    }
    return parts;
  }

  return [];
}

export function extractHoverContents(body: unknown): unknown | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if ('contents' in b) return b.contents;
  return null;
}

const HoverContent: Component<{
  contents: unknown;
  isDark: boolean;
}> = (props) => {
  const parts = () => normalizeToMarkdownParts(props.contents);
  const [renderedHtml, setRenderedHtml] = createSignal<string[]>([]);
  const [highlighter, setHighlighter] = createSignal<Highlighter | null>(null);

  createEffect(() => {
    getHighlighter().then(h => setHighlighter(h));
  });

  createEffect(async () => {
    const h = highlighter();
    const mdParts = parts();
    if (!h || mdParts.length === 0) {
      setRenderedHtml([]);
      return;
    }

    const theme = props.isDark ? 'github-dark-default' : 'github-light-default';
    const results: string[] = [];

    for (const md of mdParts) {
      results.push(await renderMarkdown(md, h, theme));
    }

    setRenderedHtml(results);
  });

  return (
    <div class="hover-content">
      <For each={renderedHtml()}>
        {(html) => <div class="hover-segment" innerHTML={html} />}
      </For>
    </div>
  );
};

export default HoverContent;
