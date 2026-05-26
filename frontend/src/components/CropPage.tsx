import { useRef, useState, useEffect, useCallback } from 'react';
import type { ShowToast } from '../types/ui';
import { fitImageToViewport } from '../utils/viewportLayout';
import './ImageCrop.css';

interface CropPageProps {
  imageFile: File;
  onCrop: (croppedFile: File) => void;
  onCancel: () => void;
  onShowToast?: ShowToast;
}

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fit image and initial crop rect to the browser viewport with padding. */
function layoutForImage(naturalWidth: number, naturalHeight: number) {
  const { displayWidth, displayHeight } = fitImageToViewport(naturalWidth, naturalHeight, {
    padding: 80,
    widthRatio: 0.8,
    heightRatio: 0.75,
    maxScale: 1,
  });

  const paddingPercent = 0.05;
  const cropArea: CropArea = {
    x: displayWidth * paddingPercent,
    y: displayHeight * paddingPercent,
    width: displayWidth * (1 - paddingPercent * 2),
    height: displayHeight * (1 - paddingPercent * 2),
  };

  return {
    imageSize: { width: naturalWidth, height: naturalHeight },
    displaySize: { width: displayWidth, height: displayHeight },
    cropArea,
  };
}

/** Prefer the upload MIME type; fall back to JPEG for canvas export. */
function outputMimeType(file: File): string {
  if (file.type && file.type.startsWith('image/')) return file.type;
  return 'image/jpeg';
}

/** Await `img.decode()` when available (avoids flash of incomplete decode). */
function whenDecoded(img: HTMLImageElement): Promise<void> {
  if (typeof img.decode === 'function') {
    return img.decode();
  }
  return Promise.resolve();
}

/** Draggable crop overlay; emits a cropped `File` then parent runs detection. */
export function CropPage({ imageFile, onCrop, onCancel, onShowToast }: CropPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const errorToastSent = useRef(false);

  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [cropArea, setCropArea] = useState<CropArea | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; cropStart: CropArea } | null>(null);
  const [dragType, setDragType] = useState<'move' | 'resize-topLeft' | 'resize-topRight' | 'resize-bottomLeft' | 'resize-bottomRight' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const objectUrl = URL.createObjectURL(imageFile);

    const applyLoaded = (img: HTMLImageElement, urlForDisplay: string) => {
      if (cancelled) return;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (nw === 0 || nh === 0) {
        setPhase('error');
        return;
      }
      const { imageSize: is, displaySize: ds, cropArea: ca } = layoutForImage(nw, nh);
      setPreviewUrl(urlForDisplay);
      setImageSize(is);
      setDisplaySize(ds);
      setCropArea(ca);
      setPhase('ready');
    };

    const fail = () => {
      if (cancelled) return;
      setPhase('error');
    };

    const loadFromDataUrl = () => {
      const reader = new FileReader();
      reader.onload = () => {
        if (cancelled) return;
        const dataUrl = reader.result as string;
        const img2 = new Image();
        img2.onload = () => {
          if (cancelled) return;
          whenDecoded(img2)
            .then(() => {
              if (cancelled) return;
              applyLoaded(img2, dataUrl);
            })
            .catch(() => {
              if (cancelled) return;
              if (img2.naturalWidth > 0 && img2.naturalHeight > 0) {
                applyLoaded(img2, dataUrl);
              } else {
                fail();
              }
            });
        };
        img2.onerror = () => fail();
        img2.src = dataUrl;
      };
      reader.onerror = () => fail();
      reader.readAsDataURL(imageFile);
    };

    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      whenDecoded(img)
        .then(() => {
          if (cancelled) return;
          applyLoaded(img, objectUrl);
        })
        .catch(() => {
          if (cancelled) return;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            applyLoaded(img, objectUrl);
            return;
          }
          URL.revokeObjectURL(objectUrl);
          loadFromDataUrl();
        });
    };
    img.onerror = () => {
      if (cancelled) return;
      URL.revokeObjectURL(objectUrl);
      loadFromDataUrl();
    };
    img.src = objectUrl;

    return () => {
      cancelled = true;
      URL.revokeObjectURL(objectUrl);
    };
  }, [imageFile]);

  useEffect(() => {
    if (phase !== 'error' || !onShowToast || errorToastSent.current) return;
    errorToastSent.current = true;
    onShowToast('Could not open this image. Try another file or use “Choose file” instead of drag-and-drop.', 'error');
  }, [phase, onShowToast]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!cropArea || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const handleSize = 12;
    const corners = [
      { x: cropArea.x, y: cropArea.y, type: 'resize-topLeft' as const },
      { x: cropArea.x + cropArea.width, y: cropArea.y, type: 'resize-topRight' as const },
      { x: cropArea.x, y: cropArea.y + cropArea.height, type: 'resize-bottomLeft' as const },
      { x: cropArea.x + cropArea.width, y: cropArea.y + cropArea.height, type: 'resize-bottomRight' as const },
    ];

    for (const corner of corners) {
      const distance = Math.sqrt(Math.pow(x - corner.x, 2) + Math.pow(y - corner.y, 2));
      if (distance < handleSize) {
        setIsDragging(true);
        setDragStart({ x, y, cropStart: { ...cropArea } });
        setDragType(corner.type);
        return;
      }
    }

    if (
      x >= cropArea.x &&
      x <= cropArea.x + cropArea.width &&
      y >= cropArea.y &&
      y <= cropArea.y + cropArea.height
    ) {
      setIsDragging(true);
      setDragStart({ x, y, cropStart: { ...cropArea } });
      setDragType('move');
    }
  }, [cropArea]);

  const handleMouseMove = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!isDragging || !dragStart || !displaySize || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const deltaX = x - dragStart.x;
    const deltaY = y - dragStart.y;
    const startCrop = dragStart.cropStart;

    if (dragType === 'move') {
      const newX = Math.max(0, Math.min(startCrop.x + deltaX, displaySize.width - startCrop.width));
      const newY = Math.max(0, Math.min(startCrop.y + deltaY, displaySize.height - startCrop.height));
      setCropArea({ ...startCrop, x: newX, y: newY });
    } else if (dragType === 'resize-topLeft') {
      const newX = Math.max(0, Math.min(startCrop.x + deltaX, startCrop.x + startCrop.width - 50));
      const newY = Math.max(0, Math.min(startCrop.y + deltaY, startCrop.y + startCrop.height - 50));
      const newWidth = startCrop.width - (newX - startCrop.x);
      const newHeight = startCrop.height - (newY - startCrop.y);
      setCropArea({ x: newX, y: newY, width: newWidth, height: newHeight });
    } else if (dragType === 'resize-topRight') {
      const newY = Math.max(0, Math.min(startCrop.y + deltaY, startCrop.y + startCrop.height - 50));
      const newWidth = Math.max(50, Math.min(startCrop.width + deltaX, displaySize.width - startCrop.x));
      const newHeight = startCrop.height - (newY - startCrop.y);
      setCropArea({ x: startCrop.x, y: newY, width: newWidth, height: newHeight });
    } else if (dragType === 'resize-bottomLeft') {
      const newX = Math.max(0, Math.min(startCrop.x + deltaX, startCrop.x + startCrop.width - 50));
      const newWidth = startCrop.width - (newX - startCrop.x);
      const newHeight = Math.max(50, Math.min(startCrop.height + deltaY, displaySize.height - startCrop.y));
      setCropArea({ x: newX, y: startCrop.y, width: newWidth, height: newHeight });
    } else if (dragType === 'resize-bottomRight') {
      const newWidth = Math.max(50, Math.min(startCrop.width + deltaX, displaySize.width - startCrop.x));
      const newHeight = Math.max(50, Math.min(startCrop.height + deltaY, displaySize.height - startCrop.y));
      setCropArea({ x: startCrop.x, y: startCrop.y, width: newWidth, height: newHeight });
    }
  }, [isDragging, dragStart, dragType, displaySize]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
    setDragType(null);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      handleMouseMove(e);
    };

    const handleGlobalMouseUp = () => {
      handleMouseUp();
    };

    const handleSelectStart = (e: Event) => {
      e.preventDefault();
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    document.addEventListener('selectstart', handleSelectStart);

    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      document.removeEventListener('selectstart', handleSelectStart);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleCrop = useCallback(async () => {
    if (!cropArea || !imageSize || !displaySize) return;

    const mime = outputMimeType(imageFile);

    try {
      const imageCrop = {
        x: Math.round((cropArea.x / displaySize.width) * imageSize.width),
        y: Math.round((cropArea.y / displaySize.height) * imageSize.height),
        width: Math.round((cropArea.width / displaySize.width) * imageSize.width),
        height: Math.round((cropArea.height / displaySize.height) * imageSize.height),
      };

      imageCrop.x = Math.max(0, Math.min(imageCrop.x, imageSize.width - 1));
      imageCrop.y = Math.max(0, Math.min(imageCrop.y, imageSize.height - 1));
      imageCrop.width = Math.max(1, Math.min(imageCrop.width, imageSize.width - imageCrop.x));
      imageCrop.height = Math.max(1, Math.min(imageCrop.height, imageSize.height - imageCrop.y));

      const fullResImg = new Image();

      await new Promise<void>((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (!dataUrl) {
            reject(new Error('Failed to read image file'));
            return;
          }

          fullResImg.onload = () => {
            const canvas = canvasRef.current || document.createElement('canvas');
            canvas.width = imageCrop.width;
            canvas.height = imageCrop.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('Failed to get canvas context'));
              return;
            }

            ctx.drawImage(
              fullResImg,
              imageCrop.x, imageCrop.y, imageCrop.width, imageCrop.height,
              0, 0, imageCrop.width, imageCrop.height
            );

            canvas.toBlob((blob) => {
              if (!blob) {
                reject(new Error('Failed to create blob'));
                return;
              }
              const croppedFile = new File([blob], imageFile.name, { type: mime });
              onCrop(croppedFile);
              resolve();
            }, mime, 0.95);
          };

          fullResImg.onerror = () => {
            reject(new Error('Failed to load full-resolution image'));
          };

          fullResImg.src = dataUrl;
        };

        reader.onerror = () => {
          reject(new Error('Failed to read image file'));
        };

        reader.readAsDataURL(imageFile);
      });
    } catch (err) {
      console.error('Error in handleCrop:', err);
      if (onShowToast) {
        onShowToast('Unable to crop this image right now. Please try again.', 'error');
      }
    }
  }, [cropArea, imageSize, displaySize, imageFile, onCrop, onShowToast]);

  if (phase === 'loading') {
    return (
      <div className="crop-page">
        <div className="crop-page-content">
          <div className="crop-page-loading" role="status" aria-live="polite">
            <div className="crop-page-loading-inner">
              <div className="crop-page-loading-spinner" aria-hidden />
              <p className="crop-page-loading-title">Preparing your image</p>
              <p className="crop-page-loading-sub">Hang tight while we get the crop tool ready.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'error' || !previewUrl || !displaySize || !cropArea) {
    return (
      <div className="crop-page">
        <div className="crop-page-content">
          <div className="crop-page-loading">
            <div className="crop-page-loading-inner crop-page-loading-inner--error">
              <p className="crop-page-loading-title">We couldn’t open this image</p>
              <p className="crop-page-loading-sub">
                The file may be corrupted, in an unsupported format, or blocked by the browser. Try a PNG or JPEG, or pick the file with the upload button instead of dragging it in.
              </p>
            </div>
          </div>
        </div>
        <div className="crop-page-actions">
          <button type="button" onClick={onCancel} className="button button-back">
            <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="crop-page">
      <p className="flow-step-instruction">
        Crop the photo so all nine puzzle pieces are clearly in frame, then submit.
      </p>
      <div className="crop-page-content">
        <div className="image-crop-container">
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          <div
            ref={containerRef}
            className="crop-display"
            role="application"
            tabIndex={0}
            aria-label="Image crop editor"
            onMouseDown={handleMouseDown}
            onMouseMove={!isDragging ? handleMouseMove : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && isDragging) {
                setIsDragging(false);
                setDragStart(null);
                setDragType(null);
              }
            }}
            style={{ userSelect: isDragging ? 'none' : 'auto' }}
          >
          {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <img
              ref={imageRef}
              src={previewUrl}
              alt="Crop preview"
              className="crop-image"
              style={{
                width: `${displaySize.width}px`,
                height: `${displaySize.height}px`,
              }}
            />

            <div className="crop-overlay">
              <div
                className="crop-darken top"
                style={{ height: `${cropArea.y}px` }}
              />
              <div
                className="crop-darken bottom"
                style={{
                  top: `${cropArea.y + cropArea.height}px`,
                  height: `${displaySize.height - cropArea.y - cropArea.height}px`,
                }}
              />
              <div
                className="crop-darken left"
                style={{
                  top: `${cropArea.y}px`,
                  width: `${cropArea.x}px`,
                  height: `${cropArea.height}px`,
                }}
              />
              <div
                className="crop-darken right"
                style={{
                  top: `${cropArea.y}px`,
                  left: `${cropArea.x + cropArea.width}px`,
                  width: `${displaySize.width - cropArea.x - cropArea.width}px`,
                  height: `${cropArea.height}px`,
                }}
              />

              <div
                className="crop-border"
                style={{
                  left: `${cropArea.x}px`,
                  top: `${cropArea.y}px`,
                  width: `${cropArea.width}px`,
                  height: `${cropArea.height}px`,
                }}
              >
                <div className="crop-handle top-left" />
                <div className="crop-handle top-right" />
                <div className="crop-handle bottom-left" />
                <div className="crop-handle bottom-right" />
              </div>
            </div>
          </div>

          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      </div>

      <div className="crop-page-actions">
        <button type="button" onClick={onCancel} className="button button-back">
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back
        </button>
        <button type="button" onClick={handleCrop} className="button button-submit">
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Submit
        </button>
      </div>
    </div>
  );
}
