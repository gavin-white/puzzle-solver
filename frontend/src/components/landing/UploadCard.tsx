import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';

interface UploadCardProps {
  onUpload: (file: File) => void;
  disabled?: boolean;
}

/** Guess image MIME from extension when the browser omits `file.type`. */
function mimeFromFileName(name: string): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const lower = name.toLowerCase();
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

/** Coerce drag/drop files to a typed `File` the rest of the app can open as an image. */
function normalizeUploadFile(file: File): File | null {
  if (file.type.startsWith('image/')) return file;
  if (file.type !== '' && file.type !== 'application/octet-stream') return null;
  const mime = mimeFromFileName(file.name);
  if (!mime) return null;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

/** Click or drag-and-drop zone capped at 10MB. */
export function UploadCard({ onUpload, disabled }: UploadCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = (file: File | null) => {
    if (!file) return;
    const normalized = normalizeUploadFile(file);
    if (!normalized) return;
    if (normalized.size > 10 * 1024 * 1024) return; // 10MB
    onUpload(normalized);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    handleFile(file ?? null);
    e.target.value = '';
  };

  const handleClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleClick();
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    handleFile(file ?? null);
  };

  return (
    <div
      className={`landing-upload-card ${dragging ? 'dragging' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleChange}
        disabled={disabled}
      />
      <div className="landing-upload-inner">
        <span className="landing-upload-btn-primary">
          <svg className="landing-upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload Puzzle Image
        </span>
        <p className="landing-upload-secondary">or drag and drop</p>
      </div>
    </div>
  );
}
