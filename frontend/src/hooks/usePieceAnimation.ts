/** CSS-transition style solve animation: progress 0→1 then callback. */
import { useState, useCallback } from 'react';
import type { AnimatingPiece } from '../components/PlayPage.types';

const ANIMATION_DURATION_MS = 600;

/** Exposes `animate(pieces, onComplete)` and progress flags for the play board. */
export function usePieceAnimation() {
  const [isAnimating, setIsAnimating] = useState(false);
  const [animatingPieces, setAnimatingPieces] = useState<AnimatingPiece[]>([]);
  const [animationProgress, setAnimationProgress] = useState(0);

  const animate = useCallback((pieces: AnimatingPiece[], onComplete: () => void) => {
    setAnimatingPieces(pieces);
    setAnimationProgress(0);
    setIsAnimating(true);

    requestAnimationFrame(() => {
      setAnimationProgress(1);
    });

    setTimeout(() => {
      onComplete();
      setIsAnimating(false);
      setAnimatingPieces([]);
    }, ANIMATION_DURATION_MS);
  }, []);

  return { isAnimating, animatingPieces, animationProgress, animate };
}
