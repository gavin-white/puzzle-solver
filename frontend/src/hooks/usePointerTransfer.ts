/**
 * Pointer-driven drag-and-drop for cluster organizing and matching steps.
 * On narrow layouts, use tap-to-select + tap-to-drop instead of drag (see tapMode).
 */
import { useState, useCallback, useEffect, useRef } from 'react';

type UsePointerTransferOptions<TItem, TTarget> = {
  onTransfer: (item: TItem, target: TTarget) => void;
  /** Resolve drop target from pointer coordinates (defaults to elementFromPoint + data attribute). */
  getTargetFromPoint?: (clientX: number, clientY: number) => TTarget | null;
  /** data attribute on drop zones, e.g. "cluster-id" */
  targetDataAttribute?: string;
  parseTarget?: (value: string) => TTarget;
  /** Tap an item, then tap a destination — standard mobile pattern; allows normal scrolling. */
  tapMode?: boolean;
  /** Compare items for tap-mode selection toggle (defaults to Object.is). */
  isSameItem?: (a: TItem, b: TItem) => boolean;
};

type ActiveDrag<TItem> = {
  item: TItem;
  pointerId: number;
  offsetX: number;
  offsetY: number;
};

export function usePointerTransfer<TItem, TTarget>({
  onTransfer,
  getTargetFromPoint,
  targetDataAttribute = 'drop-target',
  parseTarget,
  tapMode = false,
  isSameItem = Object.is,
}: UsePointerTransferOptions<TItem, TTarget>) {
  const [draggedItem, setDraggedItem] = useState<TItem | null>(null);
  const [selectedItem, setSelectedItem] = useState<TItem | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<TTarget | null>(null);
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(null);
  const activeDragRef = useRef<ActiveDrag<TItem> | null>(null);
  const removeDragListenersRef = useRef<(() => void) | null>(null);
  const onTransferRef = useRef(onTransfer);
  onTransferRef.current = onTransfer;

  useEffect(() => {
    if (!tapMode) {
      setSelectedItem(null);
    }
  }, [tapMode]);

  useEffect(() => {
    return () => {
      removeDragListenersRef.current?.();
      removeDragListenersRef.current = null;
      activeDragRef.current = null;
    };
  }, []);

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

  const resolveTargetRef = useRef(resolveTarget);
  resolveTargetRef.current = resolveTarget;

  const finishDrag = useCallback((clientX: number, clientY: number, pointerId: number) => {
    const active = activeDragRef.current;
    if (!active || active.pointerId !== pointerId) return;

    removeDragListenersRef.current?.();
    removeDragListenersRef.current = null;

    const target = resolveTargetRef.current(clientX, clientY);
    if (target !== null) {
      onTransferRef.current(active.item, target);
    }

    activeDragRef.current = null;
    setDraggedItem(null);
    setDragOverTarget(null);
    setPreviewPosition(null);
  }, []);

  const handleSelectItem = useCallback(
    (item: TItem) => {
      setSelectedItem((prev) => (prev !== null && isSameItem(prev, item) ? null : item));
    },
    [isSameItem]
  );

  const handleTapTarget = useCallback(
    (target: TTarget) => {
      setSelectedItem((selected) => {
        if (selected === null) return null;
        onTransferRef.current(selected, target);
        return null;
      });
      setDragOverTarget(null);
    },
    []
  );

  const handlePointerDown = useCallback(
    (
      e: React.PointerEvent,
      item: TItem,
      previewElement?: HTMLElement | null
    ) => {
      if (e.button !== 0 || tapMode) return;
      e.preventDefault();
      e.stopPropagation();

      removeDragListenersRef.current?.();

      const rect = previewElement?.getBoundingClientRect() ?? (e.currentTarget as HTMLElement).getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      const pointerId = e.pointerId;

      activeDragRef.current = {
        item,
        pointerId,
        offsetX,
        offsetY,
      };

      setDraggedItem(item);
      setPreviewPosition({ left: rect.left, top: rect.top });
      setDragOverTarget(null);

      const onMove = (moveEvent: PointerEvent) => {
        const current = activeDragRef.current;
        if (!current || moveEvent.pointerId !== current.pointerId) return;

        setPreviewPosition({
          left: moveEvent.clientX - current.offsetX,
          top: moveEvent.clientY - current.offsetY,
        });
        setDragOverTarget(resolveTargetRef.current(moveEvent.clientX, moveEvent.clientY));
      };

      const onEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        finishDrag(endEvent.clientX, endEvent.clientY, pointerId);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);

      removeDragListenersRef.current = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);
      };

      try {
        (e.currentTarget as HTMLElement).setPointerCapture(pointerId);
      } catch {
        // setPointerCapture may fail in some browsers; document listeners still work
      }
    },
    [tapMode, finishDrag]
  );

  return {
    draggedItem: tapMode ? null : draggedItem,
    selectedItem: tapMode ? selectedItem : null,
    dragOverTarget,
    previewPosition: tapMode ? null : previewPosition,
    isDragging: !tapMode && draggedItem !== null,
    handlePointerDown,
    handleSelectItem,
    handleTapTarget,
  };
}
