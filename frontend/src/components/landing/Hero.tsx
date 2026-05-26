import { UploadCard } from './UploadCard';

interface HeroProps {
  onUpload: (file: File) => void;
  disabled?: boolean;
}

/** Top-of-landing headline and primary upload control. */
export function Hero({ onUpload, disabled }: HeroProps) {
  return (
    <section className="landing-hero">
      <div className="landing-hero-content">
        <h1>
          Solve <span className="landing-hero-headline-accent">Scramble Squares</span> from a Photo
        </h1>
        <p className="landing-hero-sub">
          Computer vision detects each piece, matches the edges, and solves algorithmically for the completed layout.
        </p>
        <UploadCard onUpload={onUpload} disabled={disabled} />
      </div>
    </section>
  );
}
