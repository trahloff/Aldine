import { useState } from 'react';

interface Props {
  /** Width of the pane it resizes, in px. */
  value: number;
  min: number;
  max: number;
  /** 1 when the pane is on the divider's left (dragging right widens it),
   *  -1 when it is on the right. */
  side: 1 | -1;
  label: string;
  testId: string;
  className?: string;
  /** A new width, already clamped; `done` once a drag ends or a key moved it. */
  onResize(width: number, done: boolean): void;
  /** Double-click: the pane's default width. */
  onReset(): void;
  /** While held, the workspace keeps the resize cursor and its panes ignore the pointer. */
  onDragging?(dragging: boolean): void;
}

/** A vertical divider between two panes: drag it, nudge it with the arrow
 *  keys (Shift for bigger steps), double-click it to reset. */
export default function Splitter({ value, min, max, side, label, testId, className, onResize, onReset, onDragging }: Props) {
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => Math.min(Math.max(min, w), Math.max(min, max));
  return (
    <div
      className={`resizer${className ? ` ${className}` : ''}${dragging ? ' resizer--drag' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max)}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        // Capture keeps the drag alive over the PDF canvas, the editor and
        // outside the window, and it works for a finger or a pen.
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const start = value;
        let last = value;
        setDragging(true);
        onDragging?.(true);
        const move = (ev: PointerEvent) => { last = clamp(start + side * (ev.clientX - startX)); onResize(last, false); };
        const up = () => {
          setDragging(false);
          onDragging?.(false);
          if (last !== start) onResize(last, true);
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 16;
        // The arrow moves the divider; which pane that widens depends on the side.
        const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        onResize(clamp(value + side * dir * step), true);
      }}
    />
  );
}
