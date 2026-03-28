import { type Component, createMemo, createSignal, For, Show } from 'solid-js';
import type { TraceEntry } from './parser';

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
}

const Timeline: Component<{
  entries: TraceEntry[];
  pairs: Map<string, { request?: TraceEntry; response?: TraceEntry }>;
  cancellations: Map<string, TraceEntry>;
  onScrollTo: (id: number) => void;
}> = (props) => {
  // View window: [viewStart, viewEnd] in ms (relative to trace start)
  const [viewStart, setViewStart] = createSignal(0);
  const [viewEnd, setViewEnd] = createSignal(1000);
  const [isDragging, setIsDragging] = createSignal(false);
  const [dragStartX, setDragStartX] = createSignal(0);
  const [dragStartView, setDragStartView] = createSignal<[number, number]>([0, 0]);
  const [didDrag, setDidDrag] = createSignal(false);
  const [minimapDragging, setMinimapDragging] = createSignal(false);

  let trackAreaRef: HTMLDivElement | undefined;
  let minimapRef: HTMLDivElement | undefined;

  const timelineItems = createMemo(() => {
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
      });
    }

    items.sort((a, b) => a.startMs - b.startMs);
    return items;
  });

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

  // Visible items (with padding)
  const visibleItems = createMemo(() => {
    const vs = viewStart();
    const ve = viewEnd();
    return timelineItems().filter(i => i.endMs >= vs && i.startMs <= ve);
  });

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
    const dur = viewDuration();
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
        <For each={visibleItems()}>
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
