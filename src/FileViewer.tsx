import { type Component, createSignal, createMemo, createEffect, For, Show, on } from 'solid-js';
import type { TrackedFile } from './fileTracker';
import { lspLangToShiki, uriToFilename, uriToShortPath } from './fileTracker';
import { getHighlighter, loadLang, escapeHtml, type Highlighter } from './highlighter';
import { diffLines, collapseDiff, type DiffLine } from './diff';

const FileViewer: Component<{
  files: Map<string, TrackedFile>;
  isDark: boolean;
}> = (props) => {
  const [selectedUri, setSelectedUri] = createSignal<string | null>(null);
  const [snapshotIndex, setSnapshotIndex] = createSignal(0);
  const [showDiff, setShowDiff] = createSignal(false);
  const [highlightedHtml, setHighlightedHtml] = createSignal('');
  const [highlighter, setHighlighter] = createSignal<Highlighter | null>(null);

  // Initialize highlighter
  getHighlighter().then(h => setHighlighter(h));

  const sortedFiles = createMemo(() => {
    return [...props.files.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]));
  });

  const selectedFile = createMemo(() => {
    const uri = selectedUri();
    if (!uri) return null;
    return props.files.get(uri) ?? null;
  });

  const currentSnapshot = createMemo(() => {
    const file = selectedFile();
    if (!file) return null;
    const idx = Math.min(snapshotIndex(), file.snapshots.length - 1);
    return file.snapshots[idx] ?? null;
  });

  const previousSnapshot = createMemo(() => {
    const file = selectedFile();
    if (!file) return null;
    const idx = Math.min(snapshotIndex(), file.snapshots.length - 1);
    return idx > 0 ? file.snapshots[idx - 1] : null;
  });

  const diffResult = createMemo(() => {
    if (!showDiff()) return [];
    const prev = previousSnapshot();
    const curr = currentSnapshot();
    if (!prev || !curr) return [];
    const lines = diffLines(prev.text, curr.text);
    return collapseDiff(lines);
  });

  // Auto-select first file if none selected
  createEffect(() => {
    if (!selectedUri() && sortedFiles().length > 0) {
      setSelectedUri(sortedFiles()[0][0]);
    }
  });

  // Reset snapshot index when selecting a new file, jump to latest
  createEffect(on(selectedUri, () => {
    const file = selectedFile();
    if (file) {
      setSnapshotIndex(file.snapshots.length - 1);
    }
  }));

  // Highlight code when snapshot or theme changes
  createEffect(async () => {
    const snapshot = currentSnapshot();
    const h = highlighter();
    const dark = props.isDark;
    if (!snapshot || !h) {
      setHighlightedHtml('');
      return;
    }

    const lang = lspLangToShiki(snapshot.languageId);
    const loaded = await loadLang(h, lang);
    const theme = dark ? 'github-dark-default' : 'github-light-default';

    try {
      const html = h.codeToHtml(snapshot.text, {
        lang: loaded ? lang : 'text',
        theme,
      });
      setHighlightedHtml(html);
    } catch {
      // Fallback to plain text
      setHighlightedHtml(`<pre><code>${escapeHtml(snapshot.text)}</code></pre>`);
    }
  });

  return (
    <div class="file-viewer">
      <div class="file-sidebar">
        <div class="file-sidebar-header">Files ({props.files.size})</div>
        <div class="file-list">
          <For each={sortedFiles()}>
            {([uri, file]) => (
              <button
                class={`file-item ${selectedUri() === uri ? 'selected' : ''} ${file.closed ? 'closed' : ''}`}
                onClick={() => setSelectedUri(uri)}
                title={uri}
              >
                <span class="file-item-name">{uriToFilename(uri)}</span>
                <span class="file-item-path">{uriToShortPath(uri)}</span>
                <span class="file-item-meta">
                  {file.snapshots.length} ver{file.snapshots.length !== 1 ? 's' : ''}
                  {file.closed ? ' · closed' : ''}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="file-content">
        <Show when={currentSnapshot()} fallback={
          <div class="file-empty">Select a file to view its contents</div>
        }>
          {(snapshot) => {
            const file = selectedFile()!;
            return (
              <>
                <div class="file-content-header">
                  <span class="file-content-name" title={snapshot().uri}>
                    {uriToFilename(snapshot().uri)}
                  </span>
                  <span class="file-content-lang">{snapshot().languageId}</span>
                  <span class="file-content-version">v{snapshot().version}</span>
                  <span class="file-content-time">{snapshot().timestamp}</span>
                </div>
                <Show when={file.snapshots.length > 1}>
                  <div class="file-version-slider">
                    <span class="file-version-label">Version:</span>
                    <input
                      type="range"
                      min={0}
                      max={file.snapshots.length - 1}
                      value={snapshotIndex()}
                      onInput={(e) => setSnapshotIndex(parseInt(e.currentTarget.value, 10))}
                      class="file-slider"
                    />
                    <span class="file-version-num">{snapshotIndex() + 1} / {file.snapshots.length}</span>
                    <Show when={snapshotIndex() > 0}>
                      <label class="filter-toggle file-diff-toggle">
                        <input
                          type="checkbox"
                          checked={showDiff()}
                          onChange={(e) => setShowDiff(e.currentTarget.checked)}
                        />
                        Diff
                      </label>
                    </Show>
                  </div>
                </Show>
                <Show when={showDiff() && diffResult().length > 0}>
                  <div class="file-diff-view">
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
                </Show>
                <Show when={!showDiff() || diffResult().length === 0}>
                  <div class="file-code" innerHTML={highlightedHtml()} />
                </Show>
              </>
            );
          }}
        </Show>
      </div>
    </div>
  );
};

export default FileViewer;
