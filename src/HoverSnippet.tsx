import { type Component, createSignal, createEffect, Show } from 'solid-js';
import type { TrackedFile, FileSnapshot } from './fileTracker';
import { lspLangToShiki } from './fileTracker';
import { getHighlighter, loadLang, escapeHtml, type Highlighter } from './highlighter';

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Number of context lines above/below the hover target */
const CONTEXT_LINES = 2;

/** Find the latest file snapshot at or before the given entry ID */
function getSnapshotAtTime(
  files: Map<string, TrackedFile>,
  uri: string,
  entryId: number,
): FileSnapshot | undefined {
  const file = files.get(uri);
  if (!file) return undefined;

  // Snapshots are in chronological order (by entryId).
  // Find the latest one with entryId <= the hover request's entryId.
  let best: FileSnapshot | undefined;
  for (const snap of file.snapshots) {
    if (snap.entryId <= entryId) {
      best = snap;
    } else {
      break;
    }
  }
  return best;
}

function extractSnippetLines(
  text: string,
  hoverRange: LspRange,
): { lines: string[]; startLine: number; highlightStart: LspPosition; highlightEnd: LspPosition } {
  const allLines = text.split('\n');
  const firstLine = Math.max(0, hoverRange.start.line - CONTEXT_LINES);
  const lastLine = Math.min(allLines.length - 1, hoverRange.end.line + CONTEXT_LINES);
  const lines = allLines.slice(firstLine, lastLine + 1);

  return {
    lines,
    startLine: firstLine,
    highlightStart: hoverRange.start,
    highlightEnd: hoverRange.end,
  };
}

function renderSnippetHtml(
  highlighter: Highlighter,
  lines: string[],
  startLine: number,
  highlightStart: LspPosition,
  highlightEnd: LspPosition,
  cursorPosition: LspPosition,
  lang: string,
  theme: string,
): string {
  // Use shiki to tokenize each line, then wrap the highlight range with a <mark>
  // and insert a cursor indicator at the request position
  const tokens = highlighter.codeToTokens(lines.join('\n'), { lang: lang as never, theme: theme as never });
  const gutterWidth = String(startLine + lines.length).length;

  const htmlLines: string[] = [];
  for (let i = 0; i < tokens.tokens.length; i++) {
    const lineNum = startLine + i;
    const lineTokens = tokens.tokens[i];
    const gutter = String(lineNum + 1).padStart(gutterWidth);
    const isHighlightLine = lineNum >= highlightStart.line && lineNum <= highlightEnd.line;

    let col = 0;
    let lineHtml = '';

    for (const token of lineTokens) {
      const tokenStart = col;
      const tokenEnd = col + token.content.length;
      col = tokenEnd;

      const style = token.color ? ` style="color:${token.color}"` : '';

      if (!isHighlightLine) {
        // Line is outside the hover range — no mark highlighting
        lineHtml += `<span${style}>${escapeHtml(token.content)}</span>`;
        continue;
      }

      // Check if this token overlaps with the highlight range on this line
      const hlStart = lineNum === highlightStart.line ? highlightStart.character : 0;
      const hlEnd = lineNum === highlightEnd.line ? highlightEnd.character : Infinity;
      const escaped = escapeHtml(token.content);

      if (tokenEnd <= hlStart || tokenStart >= hlEnd) {
        // No overlap
        lineHtml += `<span${style}>${escaped}</span>`;
      } else if (tokenStart >= hlStart && tokenEnd <= hlEnd) {
        // Fully inside highlight
        lineHtml += `<mark class="hover-highlight"><span${style}>${escaped}</span></mark>`;
      } else {
        // Partial overlap — split the token
        const chars = [...token.content];
        let charCol = tokenStart;
        let buf = '';
        let inHighlight = charCol >= hlStart && charCol < hlEnd;

        for (const ch of chars) {
          const nowHighlight = charCol >= hlStart && charCol < hlEnd;
          if (nowHighlight !== inHighlight && buf) {
            const esc = escapeHtml(buf);
            if (inHighlight) {
              lineHtml += `<mark class="hover-highlight"><span${style}>${esc}</span></mark>`;
            } else {
              lineHtml += `<span${style}>${esc}</span>`;
            }
            buf = '';
          }
          inHighlight = nowHighlight;
          buf += ch;
          charCol++;
        }
        if (buf) {
          const esc = escapeHtml(buf);
          if (inHighlight) {
            lineHtml += `<mark class="hover-highlight"><span${style}>${esc}</span></mark>`;
          } else {
            lineHtml += `<span${style}>${esc}</span>`;
          }
        }
      }
    }

    const lineClass = isHighlightLine ? ' hover-snippet-line-highlight' : '';
    htmlLines.push(
      `<span class="hover-snippet-line${lineClass}">` +
      `<span class="hover-snippet-gutter">${gutter}</span>` +
      `<span class="hover-snippet-code">${lineHtml}</span>` +
      `</span>`
    );

    // Add caret indicator line below the cursor line
    if (lineNum === cursorPosition.line) {
      // Use the actual text content up to the cursor position to preserve tab alignment
      const sourceLine = lines[i] ?? '';
      const prefix = sourceLine.slice(0, cursorPosition.character);
      // Replace non-tab characters with spaces to maintain width, keep tabs as tabs
      const caretPad = prefix.replace(/[^\t]/g, ' ');
      htmlLines.push(
        `<span class="hover-snippet-line hover-snippet-caret-line">` +
        `<span class="hover-snippet-gutter hover-snippet-gutter-empty">${' '.repeat(gutterWidth)}</span>` +
        `<span class="hover-snippet-code">${caretPad}<span class="hover-caret">▲</span></span>` +
        `</span>`
      );
    }
  }

  const bg = tokens.bg ?? 'transparent';
  return `<pre class="hover-snippet-pre" style="background:${bg}"><code>${htmlLines.join('\n')}</code></pre>`;
}

const HoverSnippet: Component<{
  /** The hover request body (Params) */
  requestBody: unknown;
  /** The hover response body (Result) */
  responseBody: unknown;
  /** Entry ID of the hover request (to find file snapshot) */
  requestEntryId: number;
  files: Map<string, TrackedFile>;
  isDark: boolean;
}> = (props) => {
  const [html, setHtml] = createSignal('');
  const [fileUri, setFileUri] = createSignal('');
  const [highlighter, setHighlighter] = createSignal<Highlighter | null>(null);

  createEffect(() => {
    getHighlighter().then(h => setHighlighter(h));
  });

  createEffect(async () => {
    const h = highlighter();
    if (!h) return;

    // Extract URI from request
    const req = props.requestBody as { textDocument?: { uri?: string }; position?: LspPosition } | null;
    const uri = req?.textDocument?.uri;
    if (!uri) { setHtml(''); setFileUri(''); return; }
    setFileUri(uri);

    // Get the range from the response
    const res = props.responseBody as { range?: LspRange } | null;
    const range = res?.range;
    // Fall back to request position if no range in response
    const hoverRange: LspRange = range ?? {
      start: req!.position!,
      end: req!.position!,
    };

    const cursorPos: LspPosition = req!.position!;

    if (!hoverRange.start) { setHtml(''); return; }

    // Find file snapshot
    const snapshot = getSnapshotAtTime(props.files, uri, props.requestEntryId);
    if (!snapshot) { setHtml(''); return; }

    const { lines, startLine, highlightStart, highlightEnd } =
      extractSnippetLines(snapshot.text, hoverRange);

    if (lines.length === 0) { setHtml(''); return; }

    const lang = lspLangToShiki(snapshot.languageId);
    await loadLang(h, lang);
    const theme = props.isDark ? 'github-dark-default' : 'github-light-default';

    try {
      setHtml(renderSnippetHtml(h, lines, startLine, highlightStart, highlightEnd, cursorPos, lang, theme));
    } catch {
      // Fallback: plain text with line numbers
      const gutterW = String(startLine + lines.length).length;
      const plain = lines.map((l, i) => {
        const num = String(startLine + i + 1).padStart(gutterW);
        return `${num}  ${escapeHtml(l)}`;
      }).join('\n');
      setHtml(`<pre class="hover-snippet-pre"><code>${plain}</code></pre>`);
    }
  });

  return (
    <Show when={html()}>
      <div class="hover-snippet">
        <div class="hover-snippet-label">{fileUri()}</div>
        <div innerHTML={html()} />
      </div>
    </Show>
  );
};

export default HoverSnippet;
