import React, { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, GripVertical, RefreshCw } from 'lucide-react';
import { SHELF_BY_ID } from '../services/store/registry';
import { cooldownLeft, formatUpdated, manualRefresh, waitLabel, type ManualResult } from '../services/store/refresh';
import { moveItem } from '../services/store/prefs';

interface Props {
  /** Every shelf id, in the order the reader has now */
  order: string[];
  hidden: string[];
  onReorder: (order: string[]) => void;
  onToggle: (id: string) => void;
  onDone: () => void;
  onResetLayout: () => void;
}

const KIND_DOT: Record<string, string> = { official: 'bg-emerald-600', fallback: 'bg-amber-500', generated: 'bg-sky-500', curated: 'bg-stone-400' };

const MESSAGE: Record<ManualResult, string> = {
  updated: 'Updated with new books',
  unchanged: 'Checked: already up to date',
  failed: 'Could not update; your saved list is kept',
  cooldown: 'Just checked; try again in a few minutes',
  unsupported: '',
};

const iconBtn = 'w-9 h-9 shrink-0 rounded-full flex items-center justify-center border border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] active:scale-95 transition-all disabled:opacity-40';

/** Customize Store: reorder shelves, hide or show them, and see / refresh each shelf's data. Edits the layout only, never the shelves' books. */
export function StoreCustomize({ order, hidden, onReorder, onToggle, onDone, onResetLayout }: Props) {
  const list = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [, redraw] = useState(0); // re-read update times after a refresh

  // Pointer drag (works with a finger as well as a mouse; the browser's own drag-and-drop does not on touch screens).
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-shelf-row]') ?? [])];
      if (!rows.length) return;
      let to = rows.findIndex(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
      if (to === -1) to = rows.length - 1;
      const from = order.indexOf(dragging);
      if (to !== from) onReorder(moveItem(order, from, to));
      if (e.clientY < 70) window.scrollBy(0, -14); // near the edge: keep scrolling so far-away shelves can be reached
      else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
    };
    const stop = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging, order, onReorder]);

  const alive = useRef(true); // leaving Customize Store stops a Refresh all that is still working through the shelves
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = async (id: string): Promise<ManualResult> => {
    const source = SHELF_BY_ID[id]?.source;
    if (!source || busy.has(id)) return 'unsupported';
    setBusy(b => new Set(b).add(id));
    setNotes(n => ({ ...n, [id]: '' }));
    const result = await manualRefresh(source);
    if (alive.current) {
      setBusy(b => { const next = new Set(b); next.delete(id); return next; });
      setNotes(n => ({ ...n, [id]: MESSAGE[result] }));
      redraw(x => x + 1);
    }
    return result;
  };

  // Refresh all: the shelves that are showing, ONE AT A TIME, each through the same rate-limited manualRefresh as its own button
  // (so a shelf checked in the last few minutes is skipped, and no source gets more than one request at a time from here).
  const [all, setAll] = useState<{ done: number; total: number } | null>(null);
  const [allNote, setAllNote] = useState('');
  const refreshAll = async () => {
    const ids = order.filter(id => !hidden.includes(id) && SHELF_BY_ID[id]?.source?.refresh);
    if (!ids.length || all) return;
    const tally = { changed: 0, current: 0, failed: 0, skipped: 0 };
    setAllNote('');
    setAll({ done: 0, total: ids.length });
    for (const [i, id] of ids.entries()) {
      if (!alive.current) return;
      const r = await refresh(id);
      if (r === 'updated') tally.changed++;
      else if (r === 'unchanged') tally.current++;
      else if (r === 'failed') tally.failed++;
      else tally.skipped++;
      if (alive.current) setAll({ done: i + 1, total: ids.length });
    }
    if (!alive.current) return;
    setAll(null);
    const parts = [`${tally.changed} updated`, `${tally.current} already up to date`];
    if (tally.skipped) parts.push(`${tally.skipped} checked recently`);
    if (tally.failed) parts.push(`${tally.failed} could not update (saved lists kept)`);
    setAllNote(`${parts.join(', ')}.${hidden.length ? ' Hidden shelves were not refreshed.' : ''}`);
  };

  const key = (e: React.KeyboardEvent, id: string) => {
    const i = order.indexOf(id);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onReorder(moveItem(order, i, i + (e.key === 'ArrowUp' ? -1 : 1)));
    }
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Customize Store">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-serif-display text-xl text-[#201a15] dark:text-[#f0e6d6]">Customize Store</h3>
          <p className="text-xs text-[#706256] dark:text-[#a89a8a] mt-1">
            Drag ☰ to reorder (or use the arrow keys). The eye hides a shelf without deleting it. Refresh updates one shelf.
          </p>
        </div>
        <button type="button" onClick={onDone} className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#2e5934] text-white hover:bg-[#244729] flex items-center gap-1.5 shadow-sm shrink-0">
          <Check className="w-4 h-4" /> Done
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={refreshAll}
          disabled={!!all}
          className="px-3 py-2 rounded-xl text-xs font-semibold border border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] flex items-center gap-1.5 active:scale-95 transition-all disabled:opacity-60"
          title="Refresh every shelf that is showing, one at a time"
        >
          <RefreshCw className={`w-4 h-4 ${all ? 'animate-spin' : ''}`} />
          {all ? `Refreshing ${Math.min(all.done + 1, all.total)} of ${all.total}…` : 'Refresh all shelves'}
        </button>
        {allNote && !all && <span className="text-[11px] text-[#2e5934] dark:text-[#86b880]" role="status">{allNote}</span>}
      </div>

      <ul ref={list} className="flex flex-col gap-2 select-none">
        {order.map(id => {
          const def = SHELF_BY_ID[id];
          if (!def) return null;
          const info = def.source?.info?.();
          const isHidden = hidden.includes(id);
          const canRefresh = !!def.source?.refresh;
          const wait = canRefresh ? cooldownLeft(id) : 0;
          const label = def.source?.label?.() ?? def.title;
          return (
            <li
              key={id}
              data-shelf-row
              className={`flex items-center gap-2 rounded-xl border px-2 py-2 bg-[#fbf7ee] dark:bg-[#231d17] border-[#e3d7c3] dark:border-[#382f25] ${dragging === id ? 'shadow-lg ring-2 ring-[#2e5934]' : ''} ${isHidden ? 'opacity-60' : ''}`}
            >
              <button
                type="button"
                onPointerDown={e => { e.preventDefault(); setDragging(id); }}
                onKeyDown={e => key(e, id)}
                className="w-9 h-9 shrink-0 flex items-center justify-center text-[#706256] dark:text-[#a89a8a] cursor-grab touch-none"
                aria-label={`Move ${def.title}. Use the up and down arrow keys.`}
              >
                <GripVertical className="w-5 h-5" />
              </button>

              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-[#201a15] dark:text-[#f0e6d6] truncate">{label}</div>
                <div className="text-[11px] text-[#706256] dark:text-[#a89a8a] flex items-center gap-1.5 flex-wrap">
                  {info && <span className={`inline-block w-2 h-2 rounded-full ${KIND_DOT[info.kind]}`} aria-hidden="true" />}
                  <span>
                    {def.library ? 'Built from your own lists' : info ? (info.kind === 'curated' ? 'Hand-picked' : formatUpdated(info.updatedAt)) : ''}
                  </span>
                  {info && info.kind !== 'curated' && <span>· {info.schedule}</span>}
                </div>
                {info && <div className="text-[10px] text-[#706256]/80 dark:text-[#a89a8a]/80 leading-snug">{info.source}</div>}
                {notes[id] && <div className="text-[11px] text-[#2e5934] dark:text-[#86b880]" role="status">{notes[id]}</div>}
              </div>

              <button type="button" onClick={() => onToggle(id)} className={iconBtn} aria-label={isHidden ? `Show ${def.title}` : `Hide ${def.title}`} aria-pressed={isHidden} title={isHidden ? 'Show this shelf' : 'Hide this shelf'}>
                {isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              {canRefresh ? (
                <button
                  type="button"
                  onClick={() => refresh(id)}
                  disabled={busy.has(id)}
                  className={iconBtn}
                  aria-label={`Refresh ${def.title}`}
                  title={wait > 0 ? `Checked recently. Try again in ${waitLabel(wait)}.` : 'Refresh this shelf now'}
                >
                  <RefreshCw className={`w-4 h-4 ${busy.has(id) ? 'animate-spin' : ''}`} />
                </button>
              ) : (
                <span className="w-9 shrink-0" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-3 text-[11px] text-[#706256] dark:text-[#a89a8a]">
        <span>
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-600 mr-1" />official
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500 ml-3 mr-1" />public-record stand-in
          <span className="inline-block w-2 h-2 rounded-full bg-sky-500 ml-3 mr-1" />GreatReads discovery
          <span className="inline-block w-2 h-2 rounded-full bg-stone-400 ml-3 mr-1" />hand-picked
        </span>
        <button type="button" onClick={onResetLayout} className="underline underline-offset-2 hover:text-[#2e5934] dark:hover:text-[#86b880] shrink-0">Reset layout</button>
      </div>
    </section>
  );
}
