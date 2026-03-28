import { createSignal, createMemo, For, Show, type Component, onMount, onCleanup } from 'solid-js';
import { parseTrace, matchRequestResponse, getSessions, getMethodCategory, getCancellations, getCancelledRequestId, getProgressTracking, getProgressToken, sessionKey, LOG_METHODS, type TraceEntry, type Direction, type MessageType } from './parser';
import TraceEntryRow, { createExpandedSet } from './TraceEntryRow';
import { saveTrace, loadTrace, listTraces, deleteTrace, getTraceIdFromHash, clearTraceHash, formatAge, type StoredTrace } from './traceStore';
import { trackFiles } from './fileTracker';
import FileViewer from './FileViewer';
import Timeline from './Timeline';
import Analytics from './Analytics';
import './App.css';

const App: Component = () => {
  const [rawText, setRawText] = createSignal('');
  const [entries, setEntries] = createSignal<TraceEntry[]>([]);
  const [filterMethod, setFilterMethod] = createSignal('');
  const [filterDirection, setFilterDirection] = createSignal<Direction | ''>('');
  const [filterType, setFilterType] = createSignal<MessageType | ''>('');
  const [searchText, setSearchText] = createSignal('');
  const [hideLogging, setHideLogging] = createSignal(true);
  const [hideCancelled, setHideCancelled] = createSignal(false);
  const [filterSession, setFilterSession] = createSignal<number | ''>('');
  const [showImport, setShowImport] = createSignal(true);
  const [isLight, setIsLight] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<'trace' | 'files' | 'timeline' | 'analytics'>('trace');
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [showHelp, setShowHelp] = createSignal(false);
  const [traceId, setTraceId] = createSignal<string | null>(null);
  const [savedTraces, setSavedTraces] = createSignal<StoredTrace[]>([]);

  function toggleTheme() {
    const next = !isLight();
    setIsLight(next);
    document.documentElement.classList.toggle('light', next);
    try { localStorage.setItem('lsp-viewer-theme', next ? 'light' : 'dark'); } catch {}
  }

  const { expandedIds, toggle, expandAll, collapseAll } = createExpandedSet();

  async function refreshSavedTraces() {
    try { setSavedTraces(await listTraces()); } catch {}
  }

  // Restore from IndexedDB on mount
  onMount(async () => {
    // Restore theme preference
    try {
      const savedTheme = localStorage.getItem('lsp-viewer-theme');
      if (savedTheme === 'light') {
        setIsLight(true);
        document.documentElement.classList.add('light');
      }
    } catch {}

    await refreshSavedTraces();

    const id = getTraceIdFromHash();
    if (id) {
      const stored = await loadTrace(id);
      if (stored) {
        setRawText(stored.raw);
        const parsed = parseTrace(stored.raw);
        setEntries(parsed);
        if (parsed.length > 0) {
          setShowImport(false);
          setTraceId(id);
        }
      }
    }
  });

  const entryRefs: Record<number, HTMLDivElement> = {};

  const pairs = createMemo(() => matchRequestResponse(entries()));

  const sessions = createMemo(() => getSessions(entries()));

  const trackedFiles = createMemo(() => trackFiles(entries()));

  const cancellations = createMemo(() => getCancellations(entries()));

  const progressTracking = createMemo(() => getProgressTracking(entries()));

  // Build a map from session:requestId to the request entry, for $/cancelRequest linking
  const requestById = createMemo(() => {
    const map = new Map<string, TraceEntry>();
    for (const entry of entries()) {
      const key = sessionKey(entry);
      if (key === undefined || entry.messageType !== 'request') continue;
      if (entry.direction === 'sent') {
        map.set(key, entry);
      } else if (!map.has(key)) {
        map.set(key, entry);
      }
    }
    return map;
  });

  const methods = createMemo(() => {
    const set = new Set<string>();
    for (const e of entries()) set.add(e.method);
    return [...set].sort();
  });

  // Group methods by category for the dropdown
  const methodsByCategory = createMemo(() => {
    const cats = new Map<string, string[]>();
    for (const m of methods()) {
      const cat = getMethodCategory(m);
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(m);
    }
    return [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const filtered = createMemo(() => {
    let result = entries();
    const method = filterMethod();
    const dir = filterDirection();
    const type = filterType();
    const search = searchText().toLowerCase();
    const session = filterSession();
    const noise = hideLogging();
    const cancelled = hideCancelled();

    if (noise) result = result.filter(e => !LOG_METHODS.has(e.method));
    if (cancelled) {
      const cancelledKeys = new Set(cancellations().keys());
      result = result.filter(e => {
        // Hide $/cancelRequest notifications themselves
        if (e.method === '$/cancelRequest') return false;
        // Hide requests/responses that were cancelled
        const key = sessionKey(e);
        if (key !== undefined && cancelledKeys.has(key)) return false;
        return true;
      });
    }
    if (session !== '') result = result.filter(e => e.sessionIndex === session);
    if (method) {
      // Support filtering by category prefix (e.g. "textDocument/*")
      if (method.endsWith('/*')) {
        const prefix = method.slice(0, -2);
        result = result.filter(e => getMethodCategory(e.method) === prefix);
      } else {
        result = result.filter(e => e.method === method);
      }
    }
    if (dir) result = result.filter(e => e.direction === dir);
    if (type) result = result.filter(e => e.messageType === type);
    if (search) {
      result = result.filter(e =>
        e.method.toLowerCase().includes(search) ||
        e.bodyRaw.toLowerCase().includes(search) ||
        e.timestamp.includes(search)
      );
    }
    return result;
  });

  const stats = createMemo(() => {
    const all = entries();
    const requests = all.filter(e => e.messageType === 'request').length;
    const responses = all.filter(e => e.messageType === 'response').length;
    const notifications = all.filter(e => e.messageType === 'notification').length;
    const sent = all.filter(e => e.direction === 'sent').length;
    const received = all.filter(e => e.direction === 'received').length;
    return { total: all.length, requests, responses, notifications, sent, received };
  });

  async function handleParse() {
    const text = rawText();
    const parsed = parseTrace(text);
    setEntries(parsed);
    if (parsed.length > 0) {
      setShowImport(false);
      const id = await saveTrace(text);
      setTraceId(id);
      await refreshSavedTraces();
    }
    collapseAll();
  }

  function handleClear() {
    setRawText('');
    setEntries([]);
    setShowImport(true);
    setFilterMethod('');
    setFilterDirection('');
    setFilterType('');
    setSearchText('');
    setFilterSession('');
    setHideLogging(true);
    setHideCancelled(false);
    collapseAll();
    clearTraceHash();
    setTraceId(null);
  }

  function scrollToEntry(id: number) {
    // Expand the target entry
    if (!expandedIds().has(id)) {
      toggle(id);
    }
    const el = entryRefs[id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 1500);
    }
    // Update focused index
    const idx = filtered().findIndex(e => e.id === id);
    if (idx >= 0) setFocusedIndex(idx);
  }

  function getRequestLatency(entry: TraceEntry): string | undefined {
    const key = sessionKey(entry);
    if (entry.messageType !== 'request' || key === undefined) return undefined;
    const pair = pairs().get(key);
    if (!pair?.response?.latencyRaw) return undefined;
    return pair.response.latencyRaw;
  }

  function exportFiltered() {
    const data = filtered().map(e => ({
      timestamp: e.timestamp,
      direction: e.direction,
      messageType: e.messageType,
      method: e.method,
      requestId: e.requestId,
      latencyMs: e.latencyMs,
      bodyLabel: e.bodyLabel,
      body: e.body,
      sessionIndex: e.sessionIndex,
    }));
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lsp-trace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportRaw() {
    const text = rawText();
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lsp-trace-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDeleteTrace(id: string) {
    await deleteTrace(id);
    await refreshSavedTraces();
    if (traceId() === id) {
      handleClear();
    }
  }

  async function handleLoadSavedTrace(stored: StoredTrace) {
    setRawText(stored.raw);
    const parsed = parseTrace(stored.raw);
    setEntries(parsed);
    if (parsed.length > 0) {
      setShowImport(false);
      setTraceId(stored.id);
      history.replaceState(null, '', `#t=${stored.id}`);
    }
    collapseAll();
  }

  // Keyboard navigation
  let searchInputRef: HTMLInputElement | undefined;

  function handleKeyDown(e: KeyboardEvent) {
    // Help modal toggle
    if (e.key === '?' && !(e.target as HTMLElement).matches('input, textarea, select')) {
      e.preventDefault();
      setShowHelp(v => !v);
      return;
    }
    if (e.key === 'Escape' && showHelp()) {
      setShowHelp(false);
      return;
    }

    if (showImport() || activeTab() !== 'trace') return;
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

    if (e.key === '/' && !isInput) {
      e.preventDefault();
      searchInputRef?.focus();
      return;
    }
    if (e.key === 'Escape' && isInput) {
      (target as HTMLInputElement).blur();
      return;
    }
    if (isInput) return;

    const items = filtered();
    if (items.length === 0) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(focusedIndex() + 1, items.length - 1);
      setFocusedIndex(next);
      const el = entryRefs[items[next].id];
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(focusedIndex() - 1, 0);
      setFocusedIndex(prev);
      const el = entryRefs[items[prev].id];
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const idx = focusedIndex();
      if (idx >= 0 && idx < items.length) {
        toggle(items[idx].id);
      }
    }
  }

  onMount(() => document.addEventListener('keydown', handleKeyDown));
  onCleanup(() => document.removeEventListener('keydown', handleKeyDown));

  function getPairedEntry(entry: TraceEntry): TraceEntry | undefined {
    const key = sessionKey(entry);
    if (key === undefined) return undefined;
    const pair = pairs().get(key);
    if (!pair) return undefined;
    if (entry.messageType === 'request') return pair.response;
    if (entry.messageType === 'response') return pair.request;
    return undefined;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async () => {
        const text = reader.result as string;
        setRawText(text);
        const parsed = parseTrace(text);
        setEntries(parsed);
        if (parsed.length > 0) {
          setShowImport(false);
          const id = await saveTrace(text, file.name);
          setTraceId(id);
          await refreshSavedTraces();
        }
        collapseAll();
      };
      reader.readAsText(file);
    }
  }

  function handleFileInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async () => {
        const text = reader.result as string;
        setRawText(text);
        const parsed = parseTrace(text);
        setEntries(parsed);
        if (parsed.length > 0) {
          setShowImport(false);
          const id = await saveTrace(text, file.name);
          setTraceId(id);
          await refreshSavedTraces();
        }
        collapseAll();
      };
      reader.readAsText(file);
    }
  }

  return (
    <div class="app">
      <header class="app-header">
        <h1>LSP Trace Viewer</h1>
        <div class="header-actions">
          <Show when={!showImport()}>
            <button class="btn btn-secondary" onClick={exportRaw} title="Download original trace log">Save .log</button>
            <button class="btn btn-secondary" onClick={exportFiltered} title="Export filtered results as JSON">Export JSON</button>
            <button class="btn btn-secondary" onClick={() => { setShowImport(true); clearTraceHash(); setTraceId(null); }}>Import New</button>
            <button class="btn btn-secondary" onClick={handleClear}>Clear</button>
          </Show>
          <button class="btn btn-secondary btn-help" onClick={() => setShowHelp(v => !v)} title="Keyboard shortcuts (?)">?</button>
          <button class="btn btn-secondary theme-toggle" onClick={toggleTheme} title={isLight() ? 'Switch to dark mode' : 'Switch to light mode'}>
            {isLight() ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      <Show when={showImport()}>
        <section
          class="import-section"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <textarea
            class="trace-input"
            placeholder="Paste LSP trace output here, or drag & drop a log file..."
            value={rawText()}
            onInput={(e) => setRawText(e.currentTarget.value)}
          />
          <div class="import-actions">
            <button class="btn btn-primary" onClick={handleParse} disabled={!rawText()}>
              Parse Trace
            </button>
            <label class="btn btn-secondary file-btn">
              Load File
              <input type="file" accept=".log,.txt,.json" onChange={handleFileInput} hidden />
            </label>
            <Show when={entries().length > 0}>
              <button class="btn btn-secondary" onClick={() => setShowImport(false)}>
                Back to Viewer
              </button>
            </Show>
          </div>

          <Show when={savedTraces().length > 0}>
            <div class="saved-traces">
              <h3 class="saved-traces-title">Recent Traces</h3>
              <div class="saved-traces-list">
                <For each={savedTraces()}>
                  {(t) => (
                    <div class={`saved-trace-item ${traceId() === t.id ? 'active' : ''}`}>
                      <button class="saved-trace-load" onClick={() => handleLoadSavedTrace(t)}>
                        <span class="saved-trace-label">{t.label ?? `Trace ${t.id.slice(0, 6)}`}</span>
                        <span class="saved-trace-meta">{formatAge(t.createdAt)}</span>
                      </button>
                      <button
                        class="saved-trace-delete"
                        onClick={() => handleDeleteTrace(t.id)}
                        title="Delete"
                      >✕</button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </section>
      </Show>

      <Show when={entries().length > 0 && !showImport()}>
        <section class="stats-bar">
          <span class="stat">{stats().total} messages</span>
          <span class="stat stat-sent">↑ {stats().sent} sent</span>
          <span class="stat stat-received">↓ {stats().received} received</span>
          <span class="stat stat-req">{stats().requests} requests</span>
          <span class="stat stat-res">{stats().responses} responses</span>
          <span class="stat stat-not">{stats().notifications} notifications</span>
          <Show when={trackedFiles().size > 0}>
            <span class="stat">{trackedFiles().size} files</span>
          </Show>
        </section>

        <nav class="tabs">
          <button
            class={`tab ${activeTab() === 'trace' ? 'active' : ''}`}
            onClick={() => setActiveTab('trace')}
          >
            Trace
          </button>
          <button
            class={`tab ${activeTab() === 'files' ? 'active' : ''}`}
            onClick={() => setActiveTab('files')}
            disabled={trackedFiles().size === 0}
          >
            Files ({trackedFiles().size})
          </button>
          <button
            class={`tab ${activeTab() === 'timeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('timeline')}
          >
            Timeline
          </button>
          <button
            class={`tab ${activeTab() === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </button>
        </nav>

        <Show when={activeTab() === 'trace'}>
          <section class="filters">
            <input
              ref={searchInputRef}
              type="text"
              class="filter-search"
              placeholder="Search (press / to focus)..."
              value={searchText()}
              onInput={(e) => setSearchText(e.currentTarget.value)}
            />
            <select
              class="filter-select"
              value={filterMethod()}
              onChange={(e) => setFilterMethod(e.currentTarget.value)}
            >
              <option value="">All methods</option>
              <For each={methodsByCategory()}>
                {([cat, catMethods]) => (
                  <optgroup label={cat}>
                    <Show when={catMethods.length > 1}>
                      <option value={`${cat}/*`}>All {cat}/* ({catMethods.length})</option>
                    </Show>
                    <For each={catMethods}>
                      {(m) => <option value={m}>{m}</option>}
                    </For>
                  </optgroup>
                )}
              </For>
            </select>
            <select
              class="filter-select"
              value={filterDirection()}
              onChange={(e) => setFilterDirection(e.currentTarget.value as Direction | '')}
            >
              <option value="">All directions</option>
              <option value="sent">Sent</option>
              <option value="received">Received</option>
            </select>
            <select
              class="filter-select"
              value={filterType()}
              onChange={(e) => setFilterType(e.currentTarget.value as MessageType | '')}
            >
              <option value="">All types</option>
              <option value="request">Requests</option>
              <option value="response">Responses</option>
              <option value="notification">Notifications</option>
            </select>
            <Show when={sessions().length > 1}>
              <select
                class="filter-select"
                value={filterSession() === '' ? '' : String(filterSession())}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setFilterSession(v === '' ? '' : parseInt(v, 10));
                }}
              >
                <option value="">All sessions</option>
                <For each={sessions()}>
                  {(s) => (
                    <option value={String(s.index)}>
                      Session {s.index} ({s.count} msgs)
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <label class="filter-toggle" title="Hide window/logMessage, $/setTrace, $/logTrace, telemetry/event">
              <input
                type="checkbox"
                checked={hideLogging()}
                onChange={(e) => setHideLogging(e.currentTarget.checked)}
              />
              Hide logging
            </label>
            <label class="filter-toggle" title="Hide cancelled requests and $/cancelRequest notifications">
              <input
                type="checkbox"
                checked={hideCancelled()}
                onChange={(e) => setHideCancelled(e.currentTarget.checked)}
              />
              Hide cancelled
            </label>
            <div class="filter-actions">
              <button class="btn btn-small" onClick={() => expandAll(filtered().map(e => e.id))}>
                Expand All
              </button>
              <button class="btn btn-small" onClick={collapseAll}>
                Collapse All
              </button>
            </div>
            <span class="filter-count">{filtered().length} / {entries().length}</span>
          </section>

          <section class="trace-list">
            <For each={filtered()}>
              {(entry, i) => {
                const prevSession = () => {
                  const idx = i();
                  return idx > 0 ? filtered()[idx - 1]?.sessionIndex : undefined;
                };
                const showSeparator = () => {
                  const ps = prevSession();
                  return ps !== undefined && ps !== entry.sessionIndex;
                };
                return (
                  <>
                    <Show when={showSeparator()}>
                      <div class="session-separator">
                        <span class="session-separator-line" />
                        <span class="session-separator-label">Session {entry.sessionIndex} — initialize</span>
                        <span class="session-separator-line" />
                      </div>
                    </Show>
                    <div ref={(el) => { entryRefs[entry.id] = el; }} class={focusedIndex() === i() ? 'entry-focused' : ''}>
                      <TraceEntryRow
                        entry={entry}
                        isExpanded={expandedIds().has(entry.id)}
                        onToggle={() => { toggle(entry.id); setFocusedIndex(i()); }}
                        pairedEntry={getPairedEntry(entry)}
                        onScrollTo={scrollToEntry}
                        files={trackedFiles()}
                        isDark={!isLight()}
                        isCancelled={sessionKey(entry) !== undefined && cancellations().has(sessionKey(entry)!)}
                        cancelledByEntry={sessionKey(entry) !== undefined ? cancellations().get(sessionKey(entry)!) : undefined}
                        cancelTargetEntry={entry.method === '$/cancelRequest' ? (() => {
                          const rid = getCancelledRequestId(entry);
                          return rid ? requestById().get(`${entry.sessionIndex}:${rid}`) : undefined;
                        })() : undefined}
                        requestLatency={getRequestLatency(entry)}
                        progressEntries={sessionKey(entry) !== undefined ? (progressTracking().byRequest.get(sessionKey(entry)!) ?? []).flatMap(p => p.progressEntries) : undefined}
                        progressOriginEntry={entry.method === '$/progress' ? progressTracking().byProgressEntry.get(entry.id) : undefined}
                      />
                    </div>
                  </>
                );
              }}
            </For>
          </section>
        </Show>

        <Show when={activeTab() === 'timeline'}>
          <Timeline entries={entries()} pairs={pairs()} cancellations={cancellations()} sessions={sessions()} onScrollTo={(id) => { setActiveTab('trace'); requestAnimationFrame(() => scrollToEntry(id)); }} />
        </Show>

        <Show when={activeTab() === 'analytics'}>
          <Analytics entries={entries()} pairs={pairs()} cancellations={cancellations()} onScrollTo={(id) => { setActiveTab('trace'); requestAnimationFrame(() => scrollToEntry(id)); }} />
        </Show>

        <Show when={activeTab() === 'files'}>
          <FileViewer files={trackedFiles()} isDark={!isLight()} />
        </Show>
      </Show>

      <Show when={showHelp()}>
        <div class="help-overlay" onClick={() => setShowHelp(false)}>
          <div class="help-modal" onClick={(e) => e.stopPropagation()}>
            <div class="help-header">
              <h2>Keyboard Shortcuts</h2>
              <button class="help-close" onClick={() => setShowHelp(false)}>✕</button>
            </div>
            <table class="help-table">
              <tbody>
                <tr><td class="help-key"><kbd>?</kbd></td><td>Show/hide this help</td></tr>
                <tr><td class="help-key"><kbd>/</kbd></td><td>Focus search box</td></tr>
                <tr><td class="help-key"><kbd>j</kbd> / <kbd>↓</kbd></td><td>Next entry</td></tr>
                <tr><td class="help-key"><kbd>k</kbd> / <kbd>↑</kbd></td><td>Previous entry</td></tr>
                <tr><td class="help-key"><kbd>Enter</kbd> / <kbd>Space</kbd></td><td>Expand/collapse focused entry</td></tr>
                <tr><td class="help-key"><kbd>Esc</kbd></td><td>Unfocus search / close help</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default App;
