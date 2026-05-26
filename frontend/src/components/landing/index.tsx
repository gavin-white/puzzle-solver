import { useState, useCallback } from 'react';
import { Hero } from './Hero';
import { SamplePuzzles } from './SamplePuzzles';
import { HowItWorks } from './HowItWorks';
import { Footer } from './Footer';
import type { ShowToast } from '../../types/ui';
import './LandingPage.css';

interface LandingPageProps {
  onImageSelect: (file: File) => void;
  onBuiltInImageSelect: (imageUrl: string, imageName: string) => void;
  onPlayClick: (puzzleId: string, puzzleName: string) => void;
  disabled?: boolean;
  onShowToast?: ShowToast;
}

/** Marketing home: hero upload, samples, how-it-works, footer. */
export function LandingPage({
  onImageSelect,
  onBuiltInImageSelect,
  onPlayClick,
  disabled,
  onShowToast,
}: LandingPageProps) {
  const [selectedPuzzleId, setSelectedPuzzleId] = useState<string | null>('puzzle1');

  const handleSolveSample = useCallback(
    (puzzle: { id: string; name: string; fullImage: string }) => {
      onBuiltInImageSelect(puzzle.fullImage, puzzle.name);
    },
    [onBuiltInImageSelect]
  );

  const handlePlay = useCallback(
    (puzzle: { id: string; name: string }) => {
      onPlayClick(puzzle.id, puzzle.name);
    },
    [onPlayClick]
  );

  return (
    <div className="landing-page">
      <div className="landing-content">
        <Hero onUpload={onImageSelect} disabled={disabled} />
      </div>

      <div className="landing-sample-zone">
        <SamplePuzzles
          selectedId={selectedPuzzleId}
          onSelect={setSelectedPuzzleId}
          onSolve={handleSolveSample}
          onPlay={handlePlay}
          disabled={disabled}
          onShowToast={onShowToast}
        />
        <div className="landing-how-link-wrap">
          <a
            href="#how-it-works"
            className="landing-how-link"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            <span className="landing-how-link-arrow" aria-hidden>↓</span>
            How it works
          </a>
        </div>
      </div>

      <HowItWorks />
      <Footer />
    </div>
  );
}
