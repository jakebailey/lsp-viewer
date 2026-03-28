import { type Component, createSignal, Show } from 'solid-js';
import type { TraceEntry } from './parser';

const TraceEntryRow: Component<{
  entry: TraceEntry;
  isExpanded: boolean;
  onToggle: () => void;
  pairedEntry?: TraceEntry;
  onScrollTo?: (id: number) => void;
}> = (props) => {
  const dirClass = () => props.entry.direction === 'sent' ? 'dir-sent' : 'dir-received';
  const typeClass = () => `type-${props.entry.messageType}`;

  const dirArrow = () => props.entry.direction === 'sent' ? '→' : '←';
  const dirLabel = () => props.entry.direction === 'sent' ? 'Sent' : 'Recv';

  const typeBadge = () => {
    switch (props.entry.messageType) {
      case 'request': return 'REQ';
      case 'response': return 'RES';
      case 'notification': return 'NOT';
    }
  };

  const timeOnly = () => {
    const parts = props.entry.timestamp.split(' ');
    return parts[1] ?? props.entry.timestamp;
  };

  const formatBody = () => {
    if (!props.entry.body) return '';
    if (typeof props.entry.body === 'string') return props.entry.body;
    return JSON.stringify(props.entry.body, null, 2);
  };

  return (
    <div class={`trace-entry ${dirClass()} ${typeClass()} ${props.isExpanded ? 'expanded' : ''}`}>
      <div class="trace-header" onClick={props.onToggle}>
        <span class="trace-time">{timeOnly()}</span>
        <span class={`trace-dir ${dirClass()}`}>{dirArrow()} {dirLabel()}</span>
        <span class={`trace-type-badge ${typeClass()}`}>{typeBadge()}</span>
        <span class="trace-method">{props.entry.method}</span>
        <Show when={props.entry.requestId !== undefined}>
          <span class="trace-id">#{props.entry.requestId}</span>
        </Show>
        <Show when={props.entry.latencyRaw}>
          <span class="trace-latency">{props.entry.latencyRaw}</span>
        </Show>
        <Show when={props.pairedEntry}>
          <button
            class="trace-pair-link"
            onClick={(e) => {
              e.stopPropagation();
              props.onScrollTo?.(props.pairedEntry!.id);
            }}
            title={`Go to ${props.pairedEntry!.messageType === 'request' ? 'request' : 'response'}`}
          >
            {props.pairedEntry!.messageType === 'request' ? '⬆ req' : '⬇ res'}
          </button>
        </Show>
        <span class="trace-expand-icon">{props.isExpanded ? '▼' : '▶'}</span>
      </div>
      <Show when={props.isExpanded}>
        <div class="trace-body">
          <div class="trace-body-label">{props.entry.bodyLabel}:</div>
          <Show when={props.entry.body !== undefined} fallback={<div class="trace-body-empty">No content</div>}>
            <pre class="trace-body-content"><code>{formatBody()}</code></pre>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default TraceEntryRow;

export function createExpandedSet() {
  const [expandedIds, setExpandedIds] = createSignal<Set<number>>(new Set());

  function toggle(id: number) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll(ids: number[]) {
    setExpandedIds(new Set(ids));
  }

  function collapseAll() {
    setExpandedIds(new Set<number>());
  }

  return { expandedIds, toggle, expandAll, collapseAll };
}
