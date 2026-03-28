import { type Component, createSignal, createEffect, Show, For } from 'solid-js';
import type { TraceEntry } from './parser';
import type { TrackedFile, FileSnapshot } from './fileTracker';
import { lspLangToShiki } from './fileTracker';
import { getHighlighter, loadLang, escapeHtml, type Highlighter } from './highlighter';
import { diffLines, collapseDiff, type DiffLine } from './diff';

/** Get the snapshot for a given entry ID, plus the previous snapshot */
function getSnapshotsForEntry(
  files: Map<string, TrackedFile>,
  uri: string,
  entryId: number,
): { current?: FileSnapshot; previous?: FileSnapshot } {
  const file = files.get(uri);
  if (!file) return {};

  for (let i = 0; i < file.snapshots.length; i++) {
    if (file.snapshots[i].entryId === entryId) {
      return {
        current: file.snapshots[i],
        previous: i > 0 ? file.snapshots[i - 1] : undefined,
      };
    }
  }
  return {};
}

function getUriFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const doc = b.textDocument as Record<string, unknown> | undefined;
  return doc?.uri as string | undefined;
}

// ---------- didOpen file view ----------

const DidOpenContent: Component<{
  entry: TraceEntry;
  files: Map<string, TrackedFile>;
  isDark: boolean;
}> = (props) => {
  const [html, setHtml] = createSignal('');
  const [highlighter, setHighlighter] = createSignal<Highlighter | null>(null);

  getHighlighter().then(h => setHighlighter(h));

  createEffect(async () => {
    const h = highlighter();
    if (!h) return;

    const uri = getUriFromBody(props.entry.body);
    if (!uri) return;

    const { current } = getSnapshotsForEntry(props.files, uri, props.entry.id);
    if (!current) return;

    const lang = lspLangToShiki(current.languageId);
    const loaded = await loadLang(h, lang);
    const theme = props.isDark ? 'github-dark-default' : 'github-light-default';

    try {
      setHtml(h.codeToHtml(current.text, { lang: loaded ? lang : 'text', theme }));
    } catch {
      setHtml(`<pre><code>${escapeHtml(current.text)}</code></pre>`);
    }
  });

  return (
    <Show when={html()}>
      <div class="trace-file-content">
        <div class="trace-file-label">File content:</div>
        <div class="trace-file-code" innerHTML={html()} />
      </div>
    </Show>
  );
};

// ---------- didChange diff view ----------

const DidChangeContent: Component<{
  entry: TraceEntry;
  files: Map<string, TrackedFile>;
  isDark: boolean;
}> = (props) => {
  const [diffResult, setDiffResult] = createSignal<ReturnType<typeof collapseDiff>>([]);

  createEffect(() => {
    const uri = getUriFromBody(props.entry.body);
    if (!uri) return;

    const { current, previous } = getSnapshotsForEntry(props.files, uri, props.entry.id);
    if (!current || !previous) return;

    const lines = diffLines(previous.text, current.text);
    setDiffResult(collapseDiff(lines));
  });

  return (
    <Show when={diffResult().length > 0}>
      <div class="trace-file-content">
        <div class="trace-file-label">Changes:</div>
        <div class="trace-diff">
          <table class="diff-table">
            <For each={diffResult()}>
              {(line) => {
                if (line.type === 'collapse') {
                  return (
                    <tr class="diff-collapse">
                      <td class="diff-gutter" />
                      <td class="diff-gutter" />
                      <td class="diff-text">⋯ {line.count} unchanged lines</td>
                    </tr>
                  );
                }
                const dl = line as DiffLine;
                return (
                  <tr class={`diff-line diff-${dl.type}`}>
                    <td class="diff-gutter">{dl.oldLineNum ?? ''}</td>
                    <td class="diff-gutter">{dl.newLineNum ?? ''}</td>
                    <td class="diff-text">
                      <span class="diff-marker">
                        {dl.type === 'add' ? '+' : dl.type === 'remove' ? '-' : ' '}
                      </span>
                      {dl.text}
                    </td>
                  </tr>
                );
              }}
            </For>
          </table>
        </div>
      </div>
    </Show>
  );
};

// ---------- didClose view ----------

const DidCloseContent: Component<{
  entry: TraceEntry;
  files: Map<string, TrackedFile>;
}> = (props) => {
  const uri = () => getUriFromBody(props.entry.body);
  const file = () => {
    const u = uri();
    return u ? props.files.get(u) : undefined;
  };
  const snapCount = () => file()?.snapshots.length ?? 0;

  return (
    <Show when={file()}>
      <div class="trace-file-content">
        <div class="trace-file-label">
          Closed with {snapCount()} version{snapCount() !== 1 ? 's' : ''} tracked
        </div>
      </div>
    </Show>
  );
};

// ---------- Export wrapper ----------

const TraceFileContent: Component<{
  entry: TraceEntry;
  files: Map<string, TrackedFile>;
  isDark: boolean;
}> = (props) => {
  return (
    <>
      <Show when={props.entry.method === 'textDocument/didOpen'}>
        <DidOpenContent entry={props.entry} files={props.files} isDark={props.isDark} />
      </Show>
      <Show when={props.entry.method === 'textDocument/didChange'}>
        <DidChangeContent entry={props.entry} files={props.files} isDark={props.isDark} />
      </Show>
      <Show when={props.entry.method === 'textDocument/didClose'}>
        <DidCloseContent entry={props.entry} files={props.files} />
      </Show>
    </>
  );
};

export default TraceFileContent;
