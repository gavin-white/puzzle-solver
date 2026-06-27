import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import type { BoundingBox, Point } from '../types';
import type { ShowToast } from '../types/ui';
import { useNarrowLayout } from '../hooks/useNarrowLayout';
import { fitImageToContainer, fitOptionsForContainerWidth } from '../utils/viewportLayout';

interface BoundingBoxPageProps {
  imageUrl: string;
  boundingBoxes: BoundingBox[];
  onBoundingBoxesChange: (boxes: BoundingBox[], addToHistory: boolean) => void;
  onBack: () => void;
  onReset: () => void;
  onUndo: () => void;
  onSubmit: () => void;
  canUndo: boolean;
  canSubmit: boolean;
  isLoading: boolean;
  onShowToast?: ShowToast;
}

interface DragState {
  boxId: string;
  type: 'corner' | 'box';
  corner?: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  startPoint: Point;
  startBox: BoundingBox;
}

type CanvasColors = {
  accent: string;
  surface: string;
  border: string;
};

type ViewTransform = {
  scale: number;
  x: number;
  y: number;
};

type PinchState = {
  startDistance: number;
  startScale: number;
  startTranslate: ViewTransform;
  startMidpoint: Point;
};

type PanState = {
  startClient: Point;
  startTranslate: Point;
};

const MIN_VIEW_SCALE = 1;
const MAX_VIEW_SCALE = 4;

type OverlayStyle = {
  cornerRadius: number;
  lineWidth: number;
  cornerStrokeWidth: number;
};

const OVERLAY_WIDE: OverlayStyle = {
  cornerRadius: 16,
  lineWidth: 4,
  cornerStrokeWidth: 4,
};

/** Slightly larger handles on narrow — same image-space units as wide, so proportions stay consistent. */
const OVERLAY_NARROW: OverlayStyle = {
  cornerRadius: 22,
  lineWidth: 6,
  cornerStrokeWidth: 5,
};

function overlayStyleForLayout(isNarrow: boolean): OverlayStyle {
  return isNarrow ? OVERLAY_NARROW : OVERLAY_WIDE;
}

function drawBoxesOverlay(
  ctx: CanvasRenderingContext2D,
  boxes: BoundingBox[],
  colors: Pick<CanvasColors, 'accent' | 'surface'>,
  style: OverlayStyle
) {
  const accentColor = colors.accent;

  boxes.forEach((box) => {
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = style.lineWidth;
    ctx.beginPath();
    ctx.moveTo(box.topLeft.x, box.topLeft.y);
    ctx.lineTo(box.topRight.x, box.topRight.y);
    ctx.lineTo(box.bottomRight.x, box.bottomRight.y);
    ctx.lineTo(box.bottomLeft.x, box.bottomLeft.y);
    ctx.closePath();
    ctx.stroke();

    const corners = [box.topLeft, box.topRight, box.bottomLeft, box.bottomRight];
    corners.forEach((corner) => {
      ctx.beginPath();
      ctx.arc(corner.x, corner.y, style.cornerRadius, 0, Math.PI * 2);
      ctx.fillStyle = accentColor;
      ctx.fill();

      ctx.strokeStyle = colors.surface;
      ctx.lineWidth = style.cornerStrokeWidth;
      ctx.stroke();
    });
  });
}

function getCornerAtPoint(
  point: Point,
  box: BoundingBox,
  threshold: number
): 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | null {
  const corners = [
    { name: 'topLeft' as const, point: box.topLeft },
    { name: 'topRight' as const, point: box.topRight },
    { name: 'bottomLeft' as const, point: box.bottomLeft },
    { name: 'bottomRight' as const, point: box.bottomRight },
  ];

  let closestCorner: { name: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'; distance: number } | null = null;

  for (const corner of corners) {
    const distance = Math.sqrt(
      Math.pow(point.x - corner.point.x, 2) +
        Math.pow(point.y - corner.point.y, 2)
    );
    if (distance <= threshold) {
      if (!closestCorner || distance < closestCorner.distance) {
        closestCorner = { name: corner.name, distance };
      }
    }
  }

  return closestCorner ? closestCorner.name : null;
}

function isPointInBox(point: Point, box: BoundingBox): boolean {
  const minX = Math.min(box.topLeft.x, box.topRight.x, box.bottomLeft.x, box.bottomRight.x);
  const maxX = Math.max(box.topLeft.x, box.topRight.x, box.bottomLeft.x, box.bottomRight.x);
  const minY = Math.min(box.topLeft.y, box.topRight.y, box.bottomLeft.y, box.bottomRight.y);
  const maxY = Math.max(box.topLeft.y, box.topRight.y, box.bottomLeft.y, box.bottomRight.y);

  const cornerPadding = 40;
  return point.x >= minX + cornerPadding &&
         point.x <= maxX - cornerPadding &&
         point.y >= minY + cornerPadding &&
         point.y <= maxY - cornerPadding;
}

function getBoxAtPoint(
  point: Point,
  boxes: BoundingBox[],
  cornerThreshold: number
): { box: BoundingBox; corner?: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'; type: 'corner' | 'box' } | null {
  for (const box of boxes) {
    const corner = getCornerAtPoint(point, box, cornerThreshold);
    if (corner) {
      return { box, corner, type: 'corner' };
    }
  }

  for (const box of boxes) {
    if (isPointInBox(point, box)) {
      return { box, type: 'box' };
    }
  }

  return null;
}

function applyDragDelta(
  boxes: BoundingBox[],
  dragState: DragState,
  point: Point
): BoundingBox[] {
  const deltaX = point.x - dragState.startPoint.x;
  const deltaY = point.y - dragState.startPoint.y;

  return boxes.map((box) => {
    if (box.id !== dragState.boxId) return box;

    const updatedBox = { ...box };

    if (dragState.type === 'corner' && dragState.corner) {
      updatedBox[dragState.corner] = {
        x: dragState.startBox[dragState.corner].x + deltaX,
        y: dragState.startBox[dragState.corner].y + deltaY,
      };
    } else if (dragState.type === 'box') {
      updatedBox.topLeft = {
        x: dragState.startBox.topLeft.x + deltaX,
        y: dragState.startBox.topLeft.y + deltaY,
      };
      updatedBox.topRight = {
        x: dragState.startBox.topRight.x + deltaX,
        y: dragState.startBox.topRight.y + deltaY,
      };
      updatedBox.bottomLeft = {
        x: dragState.startBox.bottomLeft.x + deltaX,
        y: dragState.startBox.bottomLeft.y + deltaY,
      };
      updatedBox.bottomRight = {
        x: dragState.startBox.bottomRight.x + deltaX,
        y: dragState.startBox.bottomRight.y + deltaY,
      };
    }

    return updatedBox;
  });
}

function clampViewScale(scale: number): number {
  return Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, scale));
}

function clampViewTransform(
  transform: ViewTransform,
  viewportWidth: number,
  viewportHeight: number,
  displayWidth: number,
  displayHeight: number
): ViewTransform {
  if (transform.scale <= MIN_VIEW_SCALE) {
    return { scale: MIN_VIEW_SCALE, x: 0, y: 0 };
  }

  const scaledWidth = displayWidth * transform.scale;
  const scaledHeight = displayHeight * transform.scale;
  const minX = Math.min(0, viewportWidth - scaledWidth);
  const minY = Math.min(0, viewportHeight - scaledHeight);

  return {
    scale: transform.scale,
    x: Math.max(minX, Math.min(0, transform.x)),
    y: Math.max(minY, Math.min(0, transform.y)),
  };
}

/** Adjust nine quadrilateral boxes on the cropped image; submit sends to API. */
export function BoundingBoxPage({
  imageUrl,
  boundingBoxes,
  onBoundingBoxesChange,
  onBack,
  onReset,
  onUndo,
  onSubmit,
  canUndo,
  canSubmit,
  isLoading,
  onShowToast,
}: BoundingBoxPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const transformLayerRef = useRef<HTMLDivElement>(null);
  const imageLayerRef = useRef<HTMLCanvasElement | null>(null);
  const imageLayerKeyRef = useRef<string | null>(null);
  const liveBoxesRef = useRef(boundingBoxes);
  const committedBoxesRef = useRef(boundingBoxes);
  const dragStateRef = useRef<DragState | null>(null);
  const paintRafRef = useRef<number | null>(null);
  const onBoundingBoxesChangeRef = useRef(onBoundingBoxesChange);
  const canvasColorsRef = useRef<CanvasColors>({ accent: '#4dabf7', surface: '#ffffff', border: '#cccccc' });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const calculateDisplaySizeRef = useRef<(imgWidth: number, imgHeight: number) => { displayWidth: number; displayHeight: number }>(() => ({
    displayWidth: 0,
    displayHeight: 0,
  }));
  const canvasDisplaySizeRef = useRef({ width: 0, height: 0 });
  const viewTransformRef = useRef<ViewTransform>({ scale: 1, x: 0, y: 0 });
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const pinchStateRef = useRef<PinchState | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const isNarrowRef = useRef(false);

  const isNarrow = useNarrowLayout();
  const [isDragging, setIsDragging] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredCorner, setHoveredCorner] = useState<{ boxId: string; corner: string } | null>(null);
  const [imageLoadState, setImageLoadState] = useState<{ url: string; error: string | null } | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);

  const canvasColors = useMemo(() => {
    if (typeof window === 'undefined') {
      return { accent: '#4dabf7', surface: '#ffffff', border: '#cccccc' };
    }
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      accent: rootStyle.getPropertyValue('--color-info').trim() || '#4dabf7',
      surface: rootStyle.getPropertyValue('--color-bg-surface').trim() || '#ffffff',
      border: rootStyle.getPropertyValue('--color-border').trim() || '#cccccc',
    };
  }, []);

  const imageReady = imageLoadState?.url === imageUrl && imageLoadState?.error === null;
  const imageError = imageLoadState?.url === imageUrl ? imageLoadState?.error : null;

  const calculateDisplaySize = useCallback((imgWidth: number, imgHeight: number) => {
    const containerWidth = containerSize?.width ?? containerRef.current?.clientWidth ?? window.innerWidth;
    const width = containerWidth > 0 ? containerWidth : Math.max(window.innerWidth - 48, 280);
    const estimatedHeight = Math.max(window.innerHeight - 280, 240);
    const options = fitOptionsForContainerWidth(width);
    const { displayWidth, displayHeight } = fitImageToContainer(
      width,
      estimatedHeight,
      imgWidth,
      imgHeight,
      { ...options, heightRatio: Number.POSITIVE_INFINITY }
    );
    return { displayWidth, displayHeight };
  }, [containerSize]);

  const applyViewTransform = useCallback((transform: ViewTransform) => {
    viewTransformRef.current = transform;
    const layer = transformLayerRef.current;
    if (layer) {
      layer.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
    }
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.classList.toggle('bounding-box-viewport--zoomed', transform.scale > MIN_VIEW_SCALE);
    }
  }, []);

  useEffect(() => {
    onBoundingBoxesChangeRef.current = onBoundingBoxesChange;
  }, [onBoundingBoxesChange]);

  useEffect(() => {
    canvasColorsRef.current = canvasColors;
  }, [canvasColors]);

  useEffect(() => {
    calculateDisplaySizeRef.current = calculateDisplaySize;
  }, [calculateDisplaySize]);

  const getCanvasPoint = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const borderWidth = 1;
    const displayedWidth = rect.width - (borderWidth * 2);
    const displayedHeight = rect.height - (borderWidth * 2);

    if (displayedWidth <= 0 || displayedHeight <= 0 || canvas.width === 0 || canvas.height === 0) {
      return { x: 0, y: 0 };
    }

    const scale = canvas.width / displayedWidth;
    const mouseX = (clientX - rect.left) - borderWidth;
    const mouseY = (clientY - rect.top) - borderWidth;

    const x = Math.max(0, Math.min(canvas.width, mouseX * scale));
    const y = Math.max(0, Math.min(canvas.height, mouseY * scale));

    return { x, y };
  }, []);

  const getCornerThreshold = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return 24;
    const rect = canvas.getBoundingClientRect();
    const base = Math.max(24, rect.width * 0.04);
    return isNarrowRef.current ? base * 1.25 : base;
  }, []);

  const getViewportMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    const { width: displayWidth, height: displayHeight } = canvasDisplaySizeRef.current;
    return {
      viewportWidth: viewport?.clientWidth ?? displayWidth,
      viewportHeight: viewport?.clientHeight ?? displayHeight,
      displayWidth,
      displayHeight,
    };
  }, []);

  const ensureImageLayer = useCallback((img: HTMLImageElement) => {
    const layerKey = `${img.width}x${img.height}:${img.src}`;
    if (imageLayerRef.current && imageLayerKeyRef.current === layerKey) {
      return imageLayerRef.current;
    }

    const layer = document.createElement('canvas');
    layer.width = img.width;
    layer.height = img.height;
    const layerCtx = layer.getContext('2d');
    if (layerCtx) {
      layerCtx.drawImage(img, 0, 0);
    }

    imageLayerRef.current = layer;
    imageLayerKeyRef.current = layerKey;
    return layer;
  }, []);

  const paintCanvas = useCallback((boxes: BoundingBox[]) => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imageReady) return;

    const { displayWidth, displayHeight } = calculateDisplaySizeRef.current(img.width, img.height);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    canvasDisplaySizeRef.current = { width: displayWidth, height: displayHeight };

    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width;
      canvas.height = img.height;
    }

    const imageLayer = ensureImageLayer(img);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(imageLayer, 0, 0);
    const overlayStyle = overlayStyleForLayout(isNarrowRef.current);
    drawBoxesOverlay(ctx, boxes, canvasColorsRef.current, overlayStyle);
  }, [imageReady, ensureImageLayer]);

  const schedulePaint = useCallback(() => {
    if (paintRafRef.current !== null) return;
    paintRafRef.current = requestAnimationFrame(() => {
      paintRafRef.current = null;
      paintCanvas(liveBoxesRef.current);
    });
  }, [paintCanvas]);

  const cancelScheduledPaint = useCallback(() => {
    if (paintRafRef.current !== null) {
      cancelAnimationFrame(paintRafRef.current);
      paintRafRef.current = null;
    }
  }, []);

  const paintCanvasRef = useRef(paintCanvas);

  useEffect(() => {
    paintCanvasRef.current = paintCanvas;
  }, [paintCanvas]);

  useEffect(() => {
    isNarrowRef.current = isNarrow;

    if (!isNarrow) {
      applyViewTransform({ scale: MIN_VIEW_SCALE, x: 0, y: 0 });
      pinchStateRef.current = null;
      panStateRef.current = null;
      activePointersRef.current.clear();
      setIsPanning(false);
    }

    if (imageReady && !dragStateRef.current) {
      paintCanvasRef.current(liveBoxesRef.current);
    }
  }, [isNarrow, imageReady, applyViewTransform]);

  const cancelBoxDragWithoutCommit = useCallback(() => {
    if (!dragStateRef.current) return;
    cancelScheduledPaint();
    liveBoxesRef.current = committedBoxesRef.current;
    paintCanvasRef.current(liveBoxesRef.current);
    dragStateRef.current = null;
    setIsDragging(false);
  }, [cancelScheduledPaint]);

  const startPinchGesture = useCallback(() => {
    const pointers = [...activePointersRef.current.values()];
    const viewport = viewportRef.current;
    if (pointers.length < 2 || !viewport) return;

    const rect = viewport.getBoundingClientRect();
    const startDistance = Math.max(
      Math.hypot(pointers[1].x - pointers[0].x, pointers[1].y - pointers[0].y),
      1
    );
    const startMidpoint = {
      x: (pointers[0].x + pointers[1].x) / 2 - rect.left,
      y: (pointers[0].y + pointers[1].y) / 2 - rect.top,
    };

    pinchStateRef.current = {
      startDistance,
      startScale: viewTransformRef.current.scale,
      startTranslate: { ...viewTransformRef.current },
      startMidpoint,
    };
    panStateRef.current = null;
    setIsPanning(false);
  }, []);

  const updatePinchGesture = useCallback(() => {
    const pinch = pinchStateRef.current;
    const viewport = viewportRef.current;
    const pointers = [...activePointersRef.current.values()];
    if (!pinch || !viewport || pointers.length < 2) return;

    const rect = viewport.getBoundingClientRect();
    const distance = Math.max(
      Math.hypot(pointers[1].x - pointers[0].x, pointers[1].y - pointers[0].y),
      1
    );
    const midpoint = {
      x: (pointers[0].x + pointers[1].x) / 2 - rect.left,
      y: (pointers[0].y + pointers[1].y) / 2 - rect.top,
    };

    const scale = clampViewScale(pinch.startScale * (distance / pinch.startDistance));
    const worldX = (pinch.startMidpoint.x - pinch.startTranslate.x) / pinch.startScale;
    const worldY = (pinch.startMidpoint.y - pinch.startTranslate.y) / pinch.startScale;
    const { viewportWidth, viewportHeight, displayWidth, displayHeight } = getViewportMetrics();

    applyViewTransform(clampViewTransform(
      {
        scale,
        x: midpoint.x - worldX * scale,
        y: midpoint.y - worldY * scale,
      },
      viewportWidth,
      viewportHeight,
      displayWidth,
      displayHeight
    ));
  }, [applyViewTransform, getViewportMetrics]);

  const zoomViewAtClientPoint = useCallback((clientX: number, clientY: number, scaleMultiplier: number) => {
    const viewport = viewportRef.current;
    if (!viewport || !isNarrowRef.current) return;

    const rect = viewport.getBoundingClientRect();
    const focalX = clientX - rect.left;
    const focalY = clientY - rect.top;
    const prev = viewTransformRef.current;
    const newScale = clampViewScale(prev.scale * scaleMultiplier);
    const worldX = (focalX - prev.x) / prev.scale;
    const worldY = (focalY - prev.y) / prev.scale;
    const { viewportWidth, viewportHeight, displayWidth, displayHeight } = getViewportMetrics();

    applyViewTransform(clampViewTransform(
      {
        scale: newScale,
        x: focalX - worldX * newScale,
        y: focalY - worldY * newScale,
      },
      viewportWidth,
      viewportHeight,
      displayWidth,
      displayHeight
    ));
  }, [applyViewTransform, getViewportMetrics]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      if (dragStateRef.current || pinchStateRef.current) return;
      if (isNarrowRef.current) {
        applyViewTransform({ scale: MIN_VIEW_SCALE, x: 0, y: 0 });
      }
      setContainerSize({
        width: container.clientWidth,
        height: 0,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyViewTransform]);

  useEffect(() => {
    if (!imageUrl) return;

    let cancelled = false;
    imageRef.current = null;
    imageLayerRef.current = null;
    imageLayerKeyRef.current = null;

    const loadAndDecodeImage = async () => {
      const img = new Image();
      img.src = imageUrl;

      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to load image'));
        });

        if (img.decode) {
          await img.decode();
        }

        if (cancelled) return;

        imageRef.current = img;
        setImageLoadState({ url: imageUrl, error: null });
      } catch (err) {
        if (cancelled) return;
        setImageLoadState({ url: imageUrl, error: err instanceof Error ? err.message : 'Failed to load image' });
      }
    };

    void loadAndDecodeImage();

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useLayoutEffect(() => {
    if (!imageReady || dragStateRef.current) return;
    liveBoxesRef.current = boundingBoxes;
    committedBoxesRef.current = boundingBoxes;
    paintCanvas(boundingBoxes);
  }, [boundingBoxes, imageReady, containerSize, paintCanvas]);

  useEffect(() => {
    if (!isNarrow || !imageReady) return;

    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      if (!isNarrowRef.current) return;
      event.preventDefault();
      const scaleMultiplier = Math.exp(-event.deltaY * 0.002);
      zoomViewAtClientPoint(event.clientX, event.clientY, scaleMultiplier);
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [isNarrow, imageReady, zoomViewAtClientPoint]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      if (isNarrowRef.current && activePointersRef.current.size >= 2) {
        event.preventDefault();
        if (!pinchStateRef.current) {
          cancelBoxDragWithoutCommit();
          startPinchGesture();
        }
        updatePinchGesture();
        return;
      }

      if (dragStateRef.current) {
        event.preventDefault();
        const point = getCanvasPoint(event.clientX, event.clientY);
        liveBoxesRef.current = applyDragDelta(liveBoxesRef.current, dragStateRef.current, point);
        schedulePaint();
        return;
      }

      if (isNarrowRef.current && panStateRef.current) {
        event.preventDefault();
        const dx = event.clientX - panStateRef.current.startClient.x;
        const dy = event.clientY - panStateRef.current.startClient.y;
        const { viewportWidth, viewportHeight, displayWidth, displayHeight } = getViewportMetrics();
        applyViewTransform(clampViewTransform(
          {
            scale: viewTransformRef.current.scale,
            x: panStateRef.current.startTranslate.x + dx,
            y: panStateRef.current.startTranslate.y + dy,
          },
          viewportWidth,
          viewportHeight,
          displayWidth,
          displayHeight
        ));
        return;
      }

      const point = getCanvasPoint(event.clientX, event.clientY);
      const hit = getBoxAtPoint(point, liveBoxesRef.current, getCornerThreshold());
      if (hit) {
        if (hit.type === 'corner' && hit.corner) {
          setHoveredCorner({ boxId: hit.box.id, corner: hit.corner });
        } else {
          setHoveredCorner({ boxId: hit.box.id, corner: 'center' });
        }
      } else {
        setHoveredCorner(null);
      }
    };

    const finishDrag = () => {
      if (!dragStateRef.current) return;
      cancelScheduledPaint();
      paintCanvasRef.current(liveBoxesRef.current);
      committedBoxesRef.current = liveBoxesRef.current;
      onBoundingBoxesChangeRef.current(liveBoxesRef.current, true);
      dragStateRef.current = null;
      setIsDragging(false);
    };

    const handlePointerUp = (event: PointerEvent) => {
      activePointersRef.current.delete(event.pointerId);

      if (activePointersRef.current.size < 2) {
        pinchStateRef.current = null;
      }

      if (activePointersRef.current.size === 0) {
        if (panStateRef.current) {
          panStateRef.current = null;
          setIsPanning(false);
        }
        finishDrag();
      }
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);

    return () => {
      cancelScheduledPaint();
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [
    getCanvasPoint,
    getCornerThreshold,
    getViewportMetrics,
    schedulePaint,
    cancelScheduledPaint,
    cancelBoxDragWithoutCommit,
    startPinchGesture,
    updatePinchGesture,
    applyViewTransform,
  ]);

  const handleViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !isNarrowRef.current) return;
    event.preventDefault();

    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointersRef.current.size >= 2) {
      cancelBoxDragWithoutCommit();
      startPinchGesture();
      updatePinchGesture();
      return;
    }

    const point = getCanvasPoint(event.clientX, event.clientY);
    const hit = getBoxAtPoint(point, liveBoxesRef.current, getCornerThreshold());

    if (hit) {
      dragStateRef.current = {
        boxId: hit.box.id,
        type: hit.type,
        corner: hit.corner,
        startPoint: point,
        startBox: { ...hit.box },
      };
      setIsDragging(true);
      setHoveredCorner(null);
      panStateRef.current = null;
      setIsPanning(false);
    } else if (viewTransformRef.current.scale > MIN_VIEW_SCALE) {
      panStateRef.current = {
        startClient: { x: event.clientX, y: event.clientY },
        startTranslate: {
          x: viewTransformRef.current.x,
          y: viewTransformRef.current.y,
        },
      };
      setIsPanning(true);
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }, [
    getCanvasPoint,
    getCornerThreshold,
    cancelBoxDragWithoutCommit,
    startPinchGesture,
    updatePinchGesture,
  ]);

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || isNarrowRef.current) return;
    event.preventDefault();

    const point = getCanvasPoint(event.clientX, event.clientY);
    const hit = getBoxAtPoint(point, liveBoxesRef.current, getCornerThreshold());

    if (hit) {
      dragStateRef.current = {
        boxId: hit.box.id,
        type: hit.type,
        corner: hit.corner,
        startPoint: point,
        startBox: { ...hit.box },
      };
      setIsDragging(true);
      setHoveredCorner(null);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
  }, [getCanvasPoint, getCornerThreshold]);

  const canvasClassName =
    isDragging || isPanning
      ? 'bounding-box-canvas--grabbing'
      : hoveredCorner
        ? hoveredCorner.corner === 'center'
          ? 'bounding-box-canvas--move'
          : 'bounding-box-canvas--grab'
        : undefined;

  const canvasStyle = useMemo(() => ({
    border: '1px solid #ccc',
    borderColor: canvasColors.border,
    imageRendering: 'auto' as const,
    margin: 0,
    padding: 0,
    boxSizing: 'border-box' as const,
    touchAction: 'none' as const,
    visibility: imageReady ? ('visible' as const) : ('hidden' as const),
    position: imageReady ? ('static' as const) : ('absolute' as const),
  }), [canvasColors.border, imageReady]);

  if (imageError) {
    return <div className="error-message">Error: {imageError}</div>;
  }

  return (
    <div className="bounding-box-page">
      <p className="flow-step-instruction">
        <span className="bbox-instruction--wide">
          Drag the corners of each box so it fits tightly around one puzzle piece.
        </span>
        <span className="bbox-instruction--narrow">
          Drag corners to fit each piece. Pinch or scroll to zoom, then drag empty space to pan.
        </span>
      </p>
      <div
        className={`bounding-box-editor${isNarrow ? ' bounding-box-editor--narrow' : ''}`}
        ref={containerRef}
      >
        {!imageReady && (
          <div className="loading-message">
            Loading image...
          </div>
        )}
        {isNarrow ? (
          <div
            ref={viewportRef}
            className="bounding-box-viewport"
            onPointerDown={handleViewportPointerDown}
            onPointerLeave={() => {
              if (!dragStateRef.current && !panStateRef.current && activePointersRef.current.size === 0) {
                setHoveredCorner(null);
              }
            }}
          >
            <div ref={transformLayerRef} className="bounding-box-transform-layer">
              <canvas
                ref={canvasRef}
                className={canvasClassName}
                style={canvasStyle}
              />
            </div>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className={canvasClassName}
            style={canvasStyle}
            onPointerDown={handleCanvasPointerDown}
            onPointerLeave={() => {
              if (!dragStateRef.current) {
                setHoveredCorner(null);
              }
            }}
          />
        )}
      </div>

      <div className="bounding-box-page-actions">
        <button onClick={onBack} className="button button-back">
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          Back
        </button>
        <button
          onClick={() => {
            if (!canUndo) {
              onShowToast?.('Nothing to reset', 'info');
              return;
            }
            onReset();
          }}
          className={`button button-reset ${!canUndo ? 'button-disabled-visual' : ''}`}
          title={!canUndo ? 'Nothing to reset' : undefined}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          Reset
        </button>
        <button
          onClick={() => {
            if (!canUndo) {
              onShowToast?.('Nothing to undo', 'info');
              return;
            }
            onUndo();
          }}
          className={`button button-undo ${!canUndo ? 'button-disabled-visual' : ''}`}
          title={!canUndo ? 'Nothing to undo' : undefined}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 7v6h6"/>
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
          </svg>
          Undo
        </button>
        <button
          onClick={() => {
            if (isLoading) return;
            if (!canSubmit) {
              onShowToast?.('Please draw at least one bounding box around the puzzle pieces', 'error');
              return;
            }
            onSubmit();
          }}
          disabled={isLoading}
          className={`button button-submit ${!canSubmit && !isLoading ? 'button-submit-disabled' : ''}`}
          title={!canSubmit && !isLoading ? 'Please draw at least one bounding box around the puzzle pieces' : undefined}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          {isLoading ? 'Submitting...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
