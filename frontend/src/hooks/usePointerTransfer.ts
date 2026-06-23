/**
 * Pointer-driven drag-and-drop for cluster organizing and matching steps.
 */
import { useState, useCallback, useEffect, useRef } from 'react';

type UsePointerTransferOptions<TItem, TTarget> = {
  onTransfer: (item: TItem, target: TTarget) => void;
  /** Resolve drop target from pointer coordinates (defaults to elementFromPoint + data attribute). */
  getTargetFromPoint?: (clientX: number, clientY: number) => TTarget | null;
  /** data attribute on drop zones, e.g. "cluster-id" */
  targetDataAttribute?: string;
  parseTarget?: (value: string) => TTarget;
};

type ActiveDrag<TItem> = {
  item: TItem;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  previewLeft: number;
  previewTop: number;
};

export function usePointerTransfer<TItem, TTarget>({
  onTransfer,
  getTargetFromPoint,
  targetDataAttribute = 'drop-target',
  parseTarget,
}: UsePointerTransferOptions<TItem, TTarget>) {
  const [draggedItem, setDraggedItem] = useState<TItem | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<TTarget | null>(null);
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(null);
  const activeDragRef = useRef<ActiveDrag<TItem> | null>(null);

  const resolveTarget = useCallback(
    (clientX: number, clientY: number): TTarget | null => {
      if (getTargetFromPoint) {
        return getTargetFromPoint(clientX, clientY);
      }
      if (!parseTarget) return null;
      const element = document.elementFromPoint(clientX, clientY);
      const dropZone = element?.closest(`[data-${targetDataAttribute}]`);
      if (!dropZone) return null;
      const value = dropZone.getAttribute(`data-${targetDataAttribute}`);
      if (value === null) return null;
      return parseTarget(value);
    },
    [getTargetFromPoint, parseTarget, targetDataAttribute]
  );

  const handlePointerDown = useCallback(
    (
      e: React.PointerEvent,
      item: TItem,
      previewElement?: HTMLElement | null
    ) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = previewElement?.getBoundingClientRect() ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      activeDragRef.current = {
        item,
        pointerId: e.pointerId,
        offsetX,
        offsetY,
        previewLeft: rect.left,
        previewTop: rect.top,
      };

      setDraggedItem(item);
      setPreviewPosition({ left: rect.left, top: rect.top });
      setDragOverTarget(null);

      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture may fail in some browsers; window listeners still work
      }
    },
    []
  );

  useEffect(() => {
    if (!draggedItem) return;

    const handlePointerMove = (e: PointerEvent) => {
      const active = activeDragRef.current;
      if (!active || e.pointerId !== active.pointerId) return;

      setPreviewPosition({
        left: e.clientX - active.offsetX,
        top: e.clientY - active.offsetY,
      });
      setDragOverTarget(resolveTarget(e.clientX, e.clientY));
    };

    const finishDrag = (e: PointerEvent) => {
      const active = activeDragRef.current;
      if (!active || e.pointerId !== active.pointerId) return;

      const target = resolveTarget(e.clientX, e.clientY);
      if (target !== null) {
        onTransfer(active.item, target);
      }

      activeDragRef.current = null;
      setDraggedItem(null);
      setDragOverTarget(null);
      setPreviewPosition(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, [draggedItem, onTransfer, resolveTarget]);

  return {
    draggedItem,
    dragOverTarget,
    previewPosition,
    isDragging: draggedItem !== null,
    handlePointerDown,
  };
}
