import { type Component, createMemo, createSignal, createEffect, on, For, Show } from 'solid-js';
import type { TraceEntry } from './parser';
import type { SessionInfo } from './parser';

interface TimelineItem {
  requestId: string;
  method: string;
  request: TraceEntry;
  response?: TraceEntry;
  startMs: number;
  endMs: number;
  durationMs: number;
  isCancelled: boolean;
  isError: boolean;
  sessionIndex: number;
}

const Timeline: Component<{
  entries: TraceEntry[];
  pairs: Map<string, { request?: TraceEntry; response?: TraceEntry }>;
  cancellations: Map<string, TraceEntry>;
  sessions: SessionInfo[];
  onScrollTo: (id: number) => void;
}> = (props) => {
  // View window: [viewStart, viewEnd] in ms (relative to trace start)
  const [viewStart, setViewStart] = createSignal(0);
  const [viewEnd, setViewEnd] = createSignal(1000);
  const [filterSession, setFilterSession] = createSignal<number | ''>('');
  const [collapseGaps, setCollapseGaps] = createSignal(false);
  const [hideCancelled, setHideCancelled] = createSignal(false);
  const [gapThresholdMs] = createSignal(2000); // gaps > 2s get collapsed
  const [isDragging, setIsDragging] = createSignal(false);
  const [dragStartX, setDragStartX] = createSignal(0);
  const [dragStartView, setDragStartView] = createSignal<[number, number]>([0, 0]);
  const [didDrag, setDidDrag] = createSignal(false);
  const [minimapDragging, setMinimapDragging] = createSignal(false);

  let trackAreaRef: HTMLDivElement | undefined;
  let minimapRef: HTMLDivElement | undefined;

  const allTimelineItems = createMemo(() => {
    const items: TimelineItem[] = [];
    const base = props.entries.length > 0 ? parseTimestamp(props.entries[0].timestamp) : 0;

    for (const [reqId, pair] of props.pairs) {
      if (!pair.request) continue;
      const startMs = parseTimestamp(pair.request.timestamp) - base;
      const endMs = pair.response ? parseTimestamp(pair.response.timestamp) - base : startMs + 100;
      const durationMs = pair.response?.latencyMs ?? (endMs - startMs);
      items.push({
        requestId: reqId,
        method: pair.request.method,
        request: pair.request,
        response: pair.response,
        startMs,
        endMs,
        durationMs,
        isCancelled: props.cancellations.has(reqId),
        isError: pair.response?.bodyLabel === 'Error',
        sessionIndex: pair.request.sessionIndex,
      });
    }

    items.sort((a, b) => a.startMs - b.startMs);
    return items;
  });

  // Filter by session and rebase timestamps
  const sessionFiltered = createMemo(() => {
    const session = filterSession();
    const all = allTimelineItems();
    if (session === '') return all;

    const sessionItems = all.filter(i => i.sessionIndex === session);
    if (sessionItems.length === 0) return sessionItems;

    // Rebase to session start
    const base = sessionItems[0].startMs;
    return sessionItems.map(i => ({ ...i, startMs: i.startMs - base, endMs: i.endMs - base }));
  });

  // Detect gaps between activity regions
  const gaps = createMemo(() => {
    const items = sessionFiltered();
    const threshold = gapThresholdMs();
    if (items.length < 2) return [];

    // Build a timeline of "active" spans, then find gaps between them
    const spans: Array<{ start: number; end: number }> = [];
    for (const item of items) {
      if (spans.length > 0 && item.startMs <= spans[spans.length - 1].end + threshold) {
        spans[spans.length - 1].end = Math.max(spans[spans.length - 1].end, item.endMs);
      } else {
        spans.push({ start: item.startMs, end: item.endMs });
      }
    }

    const result: Array<{ start: number; end: number; duration: number }> = [];
    for (let i = 1; i < spans.length; i++) {
      const gapStart = spans[i - 1].end;
      const gapEnd = spans[i].start;
      const duration = gapEnd - gapStart;
      if (duration > threshold) {
        result.push({ start: gapStart, end: gapEnd, duration });
      }
    }
    return result;
  });

  // Remap a timestamp if gap collapsing is on
  function remapTime(ms: number): number {
    if (!collapseGaps()) return ms;
    const COLLAPSED_GAP = 200;
    let offset = 0;
    for (const gap of gaps()) {
      if (ms <= gap.start) break;
      if (ms >= gap.end) {
        offset += gap.duration - COLLAPSED_GAP;
      } else {
        // Inside a gap — clamp to gap start + small offset
        offset += (ms - gap.start) - Math.min(ms - gap.start, COLLAPSED_GAP);
      }
    }
    return ms - offset;
  }

  const timelineItems = createMemo(() => {
    let items = sessionFiltered();
    if (hideCancelled()) items = items.filter(i => !i.isCancelled);
    if (!collapseGaps() || gaps().length === 0) return items;
    return items.map(i => ({
      ...i,
      startMs: remapTime(i.startMs),
      endMs: remapTime(i.endMs),
    }));
  });

  // Collapsed gap markers for display (remapped positions)
  const gapMarkers = createMemo(() => {
    if (!collapseGaps()) return [];
    const COLLAPSED_GAP = 200;
    return gaps().map(g => ({
      position: remapTime(g.start),
      width: COLLAPSED_GAP,
      originalDuration: g.duration,
    }));
  });

  // Reset view when session filter or collapse changes
  createEffect(on(() => [filterSession(), collapseGaps()] as const, () => {
    const items = timelineItems();
    const max = items.length > 0 ? Math.max(...items.map(i => i.endMs), 1000) : 1000;
    setViewStart(0);
    setViewEnd(max);
  }));

  const totalDuration = createMemo(() => {
    const items = timelineItems();
    if (items.length === 0) return 1000;
    return Math.max(...items.map(i => i.endMs), 1000);
  });

  // Reset view when data changes
  const resetView = () => {
    setViewStart(0);
    setViewEnd(totalDuration());
  };

  // Auto-fit on first load
  createMemo(() => {
    const d = totalDuration();
    if (d > 0 && viewEnd() === 1000 && d !== 1000) {
      setViewEnd(d);
    }
  });

  const viewDuration = () => viewEnd() - viewStart();

  const formatMs = (ms: number) => {
    if (ms < 0) ms = 0;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  // Scale ticks for the current view
  const scaleTicks = createMemo(() => {
    const dur = viewDuration();
    const count = 5;
    const ticks: number[] = [];
    for (let i = 0; i <= count; i++) {
      ticks.push(viewStart() + (dur * i) / count);
    }
    return ticks;
  });

  // Zoom centered on a point
  function zoom(factor: number, centerFrac?: number) {
    const total = totalDuration();
    const dur = viewDuration();
    const center = viewStart() + dur * (centerFrac ?? 0.5);
    const newDur = Math.max(Math.min(dur * factor, total), 10);
    let newStart = center - newDur / 2;
    let newEnd = center + newDur / 2;
    // Clamp
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > total) { newStart -= (newEnd - total); newEnd = total; }
    newStart = Math.max(0, newStart);
    newEnd = Math.min(total, newEnd);
    setViewStart(newStart);
    setViewEnd(newEnd);
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = trackAreaRef?.getBoundingClientRect();
    if (!rect) return;

    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // Zoom
      const centerFrac = (e.clientX - rect.left) / rect.width;
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      zoom(factor, centerFrac);
    } else {
      // Horizontal pan
      const panAmount = (e.deltaX / rect.width) * viewDuration();
      pan(panAmount);
    }
  }

  function pan(deltaMs: number) {
    const total = totalDuration();
    let newStart = viewStart() + deltaMs;
    let newEnd = viewEnd() + deltaMs;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > total) { newStart -= (newEnd - total); newEnd = total; }
    setViewStart(Math.max(0, newStart));
    setViewEnd(Math.min(total, newEnd));
  }

  // Track drag to pan — uses pointer capture for reliable tracking
  function handleTrackPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setIsDragging(true);
    setDidDrag(false);
    setDragStartX(e.clientX);
    setDragStartView([viewStart(), viewEnd()]);
    e.preventDefault();
  }

  function handleTrackPointerMove(e: PointerEvent) {
    if (!isDragging()) return;
    const rect = trackAreaRef?.getBoundingClientRect();
    if (!rect) return;
    const dx = e.clientX - dragStartX();
    if (Math.abs(dx) > 3) setDidDrag(true);
    const sv = dragStartView();
    const dur = sv[1] - sv[0];
    const panMs = -(dx / rect.width) * dur;
    const total = totalDuration();
    let newStart = sv[0] + panMs;
    let newEnd = newStart + dur;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > total) { newStart -= (newEnd - total); newEnd = total; }
    setViewStart(Math.max(0, newStart));
    setViewEnd(Math.min(total, newEnd));
  }

  function handleTrackPointerUp() {
    setIsDragging(false);
  }

  // Minimap drag — also uses pointer capture
  function handleMinimapPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setMinimapDragging(true);
    applyMinimapPosition(e);
    e.preventDefault();
  }

  function handleMinimapPointerMove(e: PointerEvent) {
    if (!minimapDragging()) return;
    applyMinimapPosition(e);
  }

  function handleMinimapPointerUp() {
    setMinimapDragging(false);
  }

  function applyMinimapPosition(e: PointerEvent) {
    const rect = minimapRef?.getBoundingClientRect();
    if (!rect) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const total = totalDuration();
    const dur = viewDuration();
    let center = frac * total;
    let newStart = center - dur / 2;
    let newEnd = center + dur / 2;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > total) { newStart -= (newEnd - total); newEnd = total; }
    setViewStart(Math.max(0, newStart));
    setViewEnd(Math.min(total, newEnd));
  }

  function zoomToFit() {
    resetView();
  }

  function zoomIn() { zoom(0.5); }
  function zoomOut() { zoom(2); }

  return (
    <div class="timeline">
      <div class="timeline-toolbar">
        <button class="btn btn-small" onClick={zoomIn} title="Zoom in">+</button>
        <button class="btn btn-small" onClick={zoomOut} title="Zoom out">−</button>
        <button class="btn btn-small" onClick={zoomToFit} title="Fit all">Fit</button>
        <Show when={props.sessions.length > 1}>
          <select
            class="filter-select timeline-session-select"
            value={filterSession() === '' ? '' : String(filterSession())}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setFilterSession(v === '' ? '' : parseInt(v, 10));
            }}
          >
            <option value="">All sessions</option>
            <For each={props.sessions}>
              {(s) => <option value={String(s.index)}>Session {s.index} ({s.count} msgs)</option>}
            </For>
          </select>
        </Show>
        <label class="filter-toggle timeline-gap-toggle" title="Collapse idle gaps longer than 2s">
          <input
            type="checkbox"
            checked={collapseGaps()}
            onChange={(e) => setCollapseGaps(e.currentTarget.checked)}
          />
          Hide gaps
          <Show when={collapseGaps() && gaps().length > 0}>
            <span class="timeline-gap-count">({gaps().length})</span>
          </Show>
        </label>
        <label class="filter-toggle" title="Hide cancelled requests">
          <input
            type="checkbox"
            checked={hideCancelled()}
            onChange={(e) => setHideCancelled(e.currentTarget.checked)}
          />
          Hide cancelled
        </label>
        <span class="timeline-toolbar-info">
          {formatMs(viewStart())} — {formatMs(viewEnd())} ({formatMs(viewDuration())})
        </span>
        <span class="timeline-toolbar-hint">Scroll to zoom · Drag to pan</span>
      </div>

      {/* Minimap */}
      <div
        class="timeline-minimap"
        ref={minimapRef}
        on:pointerdown={handleMinimapPointerDown}
        on:pointermove={handleMinimapPointerMove}
        on:pointerup={handleMinimapPointerUp}
      >
        <div class="timeline-minimap-track">
          <For each={timelineItems()}>
            {(item) => {
              const total = totalDuration();
              const left = (item.startMs / total) * 100;
              const width = Math.max(((item.endMs - item.startMs) / total) * 100, 0.15);
              const cls = item.isError ? 'minimap-bar-error' : item.isCancelled ? 'minimap-bar-cancelled' : 'minimap-bar-ok';
              return <div class={`timeline-minimap-bar ${cls}`} style={`left:${left}%;width:${width}%`} />;
            }}
          </For>
          <For each={gapMarkers()}>
            {(marker) => {
              const total = totalDuration();
              const left = (marker.position / total) * 100;
              const width = Math.max((marker.width / total) * 100, 0.3);
              return (
                <div
                  class="timeline-minimap-gap"
                  style={`left:${left}%;width:${width}%`}
                  title={`Gap: ${formatMs(marker.originalDuration)} collapsed`}
                />
              );
            }}
          </For>
        </div>
        <div
          class="timeline-minimap-viewport"
          style={`left:${(viewStart() / totalDuration()) * 100}%;width:${(viewDuration() / totalDuration()) * 100}%`}
        />
      </div>

      <div class="timeline-header">
        <span class="timeline-label">Method</span>
        <span class="timeline-scale">
          <For each={scaleTicks()}>
            {(tick) => <span>{formatMs(tick)}</span>}
          </For>
        </span>
      </div>
      <div
        class={`timeline-body ${isDragging() ? 'timeline-dragging' : ''}`}
        ref={trackAreaRef}
        onWheel={handleWheel}
      >
        <For each={timelineItems()}>
          {(item) => {
            const vs = viewStart;
            const dur = viewDuration;
            const left = () => ((item.startMs - vs()) / dur()) * 100;
            const width = () => Math.max(((item.endMs - item.startMs) / dur()) * 100, 0.4);
            const barClass = () => {
              if (item.isError) return 'timeline-bar-error';
              if (item.isCancelled) return 'timeline-bar-cancelled';
              if (!item.response) return 'timeline-bar-pending';
              return 'timeline-bar-ok';
            };
            return (
              <div class="timeline-row">
                <button
                  class="timeline-method"
                  onClick={() => { if (!didDrag()) props.onScrollTo(item.request.id); }}
                  title={`${item.method} #${item.requestId} — ${formatMs(item.durationMs)}`}
                >
                  <span class="timeline-method-text">{item.method}</span>
                  <span class="timeline-req-id">#{item.requestId}</span>
                </button>
                <div
                  class="timeline-track"
                  on:pointerdown={handleTrackPointerDown}
                  on:pointermove={handleTrackPointerMove}
                  on:pointerup={handleTrackPointerUp}
                >
                  <For each={gapMarkers()}>
                    {(marker) => {
                      const gLeft = () => ((marker.position - vs()) / dur()) * 100;
                      const gWidth = () => Math.max((marker.width / dur()) * 100, 0.2);
                      return (
                        <div
                          class="timeline-gap-marker"
                          style={`left:${gLeft()}%;width:${gWidth()}%`}
                          title={`Gap: ${formatMs(marker.originalDuration)} collapsed`}
                        />
                      );
                    }}
                  </For>
                  <div
                    class={`timeline-bar ${barClass()}`}
                    style={`left:${left()}%;width:${width()}%`}
                    title={`${formatMs(item.durationMs)}${item.isCancelled ? ' (cancelled)' : ''}${item.isError ? ' (error)' : ''}`}
                  >
                    <Show when={width() > 4}>
                      <span class="timeline-bar-label">{formatMs(item.durationMs)}</span>
                    </Show>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={timelineItems().length === 0}>
        <div class="timeline-empty">No request/response pairs found</div>
      </Show>
    </div>
  );
};

function parseTimestamp(ts: string): number {
  // "2026-03-27 21:18:04.090" or "9:31:59 PM" format
  if (ts.includes('-')) {
    const d = new Date(ts.replace(' ', 'T'));
    return d.getTime();
  }
  // Old format — just use relative positioning
  const parts = ts.match(/(\d+):(\d+):(\d+)\s*(AM|PM)?/i);
  if (!parts) return 0;
  let h = parseInt(parts[1]);
  const m = parseInt(parts[2]);
  const s = parseInt(parts[3]);
  if (parts[4]?.toUpperCase() === 'PM' && h !== 12) h += 12;
  if (parts[4]?.toUpperCase() === 'AM' && h === 12) h = 0;
  return (h * 3600 + m * 60 + s) * 1000;
}

export default Timeline;
