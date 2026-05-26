import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import type { BoundingBox, Point } from '../types';
import type { ShowToast } from '../types/ui';
import { fitImageToViewport } from '../utils/viewportLayout';

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
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [hoveredCorner, setHoveredCorner] = useState<{ boxId: string; corner: string } | null>(null);
  const [imageLoadState, setImageLoadState] = useState<{ url: string; error: string | null } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

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
    const { displayWidth, displayHeight, scale } = fitImageToViewport(imgWidth, imgHeight, {
      padding: 80,
      widthRatio: 0.9,
      heightRatio: Number.POSITIVE_INFINITY,
    });
    return {
      displayWidth,
      displayHeight,
      scale
    };
  }, []);

  const applyCanvasStyles = useCallback((canvas: HTMLCanvasElement, displayWidth: number, displayHeight: number) => {
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    canvas.style.maxWidth = '90%';
  }, []);

  useEffect(() => {
    if (!imageUrl) return;
    
    let cancelled = false;
    imageRef.current = null;
    
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

  // Keep sizing and drawing together in layout effect to avoid Firefox canvas flicker.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    
    if (!canvas || !img || !imageReady) {
      return;
    }
    
    const { displayWidth, displayHeight } = calculateDisplaySize(img.width, img.height);
    
    applyCanvasStyles(canvas, displayWidth, displayHeight);
    
    canvas.width = img.width;
    canvas.height = img.height;
    
    // Force layout before drawing so Firefox paints the resized canvas correctly.
    const _forceLayout = getComputedStyle(canvas).visibility;
    void _forceLayout;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    
    ctx.drawImage(img, 0, 0);
    
    const accentColor = canvasColors.accent;
    
    boundingBoxes.forEach((box) => {
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(box.topLeft.x, box.topLeft.y);
      ctx.lineTo(box.topRight.x, box.topRight.y);
      ctx.lineTo(box.bottomRight.x, box.bottomRight.y);
      ctx.lineTo(box.bottomLeft.x, box.bottomLeft.y);
      ctx.closePath();
      ctx.stroke();

      const cornerRadius = 16;
      const corners = [box.topLeft, box.topRight, box.bottomLeft, box.bottomRight];
      corners.forEach((corner) => {
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, cornerRadius, 0, Math.PI * 2);
        ctx.fillStyle = accentColor;
        ctx.fill();
        
        ctx.strokeStyle = canvasColors.surface;
        ctx.lineWidth = 4;
        ctx.stroke();
      });
    });
  }, [imageReady, boundingBoxes, calculateDisplaySize, applyCanvasStyles, canvasColors]);

  useEffect(() => {
    if (!imageReady || !imageRef.current) return;
    
    const handleResize = () => {
      const canvas = canvasRef.current;
      const img = imageRef.current;
      if (!canvas || !img) return;

      const { displayWidth, displayHeight } = calculateDisplaySize(img.width, img.height);
      applyCanvasStyles(canvas, displayWidth, displayHeight);
      
      const _forceLayout = getComputedStyle(canvas).visibility;
      void _forceLayout;
      
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [imageReady, calculateDisplaySize, applyCanvasStyles]);

  const getCornerAtPoint = useCallback((
    point: Point,
    box: BoundingBox,
    threshold = 24
  ): 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | null => {
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
  }, []);

  const isPointInBox = useCallback((point: Point, box: BoundingBox): boolean => {
    const minX = Math.min(box.topLeft.x, box.topRight.x, box.bottomLeft.x, box.bottomRight.x);
    const maxX = Math.max(box.topLeft.x, box.topRight.x, box.bottomLeft.x, box.bottomRight.x);
    const minY = Math.min(box.topLeft.y, box.topRight.y, box.bottomLeft.y, box.bottomRight.y);
    const maxY = Math.max(box.topLeft.y, box.topRight.y, box.bottomLeft.y, box.bottomRight.y);
    
    const cornerPadding = 40;
    return point.x >= minX + cornerPadding && 
           point.x <= maxX - cornerPadding &&
           point.y >= minY + cornerPadding && 
           point.y <= maxY - cornerPadding;
  }, []);

  const getBoxAtPoint = useCallback((
    point: Point,
    cornerThreshold = 24
  ): { box: BoundingBox; corner?: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'; type: 'corner' | 'box' } | null => {
    for (const box of boundingBoxes) {
      const corner = getCornerAtPoint(point, box, cornerThreshold);
      if (corner) {
        return { box, corner, type: 'corner' };
      }
    }
    
    for (const box of boundingBoxes) {
      if (isPointInBox(point, box)) {
        return { box, type: 'box' };
      }
    }
    
    return null;
  }, [boundingBoxes, getCornerAtPoint, isPointInBox]);

  const getCanvasPoint = useCallback((event: ReactMouseEvent<HTMLCanvasElement>): Point => {
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
    const mouseX = (event.clientX - rect.left) - borderWidth;
    const mouseY = (event.clientY - rect.top) - borderWidth;
    
    const x = Math.max(0, Math.min(canvas.width, mouseX * scale));
    const y = Math.max(0, Math.min(canvas.height, mouseY * scale));

    return { x, y };
  }, []);

  const handleMouseDown = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const point = getCanvasPoint(event);
    const hit = getBoxAtPoint(point);

    if (hit) {
      setDragState({
        boxId: hit.box.id,
        type: hit.type,
        corner: hit.corner,
        startPoint: point,
        startBox: { ...hit.box },
      });
    }
  }, [getCanvasPoint, getBoxAtPoint]);

  const handleMouseMove = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (dragState) {
      event.preventDefault();
    }
    const point = getCanvasPoint(event);

    if (dragState) {
      const deltaX = point.x - dragState.startPoint.x;
      const deltaY = point.y - dragState.startPoint.y;

      const updatedBoxes = boundingBoxes.map((box) => {
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

      onBoundingBoxesChange(updatedBoxes, false);
    } else {
      const hit = getBoxAtPoint(point);
      if (hit) {
        if (hit.type === 'corner' && hit.corner) {
          setHoveredCorner({ boxId: hit.box.id, corner: hit.corner });
        } else {
          setHoveredCorner({ boxId: hit.box.id, corner: 'center' });
        }
      } else {
        setHoveredCorner(null);
      }
    }
  }, [dragState, boundingBoxes, getCanvasPoint, getBoxAtPoint, onBoundingBoxesChange]);

  const handleMouseUp = useCallback(() => {
    if (dragState) {
      onBoundingBoxesChange(boundingBoxes, true);
    }
    setDragState(null);
  }, [dragState, boundingBoxes, onBoundingBoxesChange]);

  if (imageError) {
    return <div className="error-message">Error: {imageError}</div>;
  }

  return (
    <div className="bounding-box-page">
      <p className="flow-step-instruction">
        Drag the corners of each box so it fits tightly around one puzzle piece.
      </p>
      <div className="bounding-box-editor" ref={containerRef}>
        {!imageReady && (
          <div className="loading-message">
            Loading image...
          </div>
        )}
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            cursor: dragState
              ? 'grabbing'
              : hoveredCorner
                ? hoveredCorner.corner === 'center' ? 'move' : 'grab'
                : 'default',
            border: '1px solid #ccc',
            borderColor: canvasColors.border,
            visibility: imageReady ? 'visible' : 'hidden',
            position: imageReady ? 'static' : 'absolute',
            imageRendering: 'auto',
            margin: 0,
            padding: 0,
            boxSizing: 'border-box',
          }}
        />
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
