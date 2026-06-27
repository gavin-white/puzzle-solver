import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { PuzzleCard } from './PuzzleCard';
import type { ShowToast } from '../../types/ui';

const PUZZLE_IDS = ['puzzle1', 'puzzle2', 'puzzle3', 'puzzle4', 'puzzle5'];
const NARROW_CAROUSEL_QUERY = '(max-width: 768px)';

export function getDefaultSamplePuzzleId(): string | null {
  if (PUZZLE_IDS.length === 0) return null;
  return PUZZLE_IDS[Math.floor(PUZZLE_IDS.length / 2)] ?? null;
}

function getCarouselFadeWidthPx(wrap: HTMLElement): number {
  const raw = getComputedStyle(wrap).getPropertyValue('--landing-carousel-fade').trim();
  if (raw.endsWith('rem')) {
    return parseFloat(raw) * parseFloat(getComputedStyle(wrap).fontSize);
  }
  if (raw.endsWith('px')) {
    return parseFloat(raw);
  }
  return 40;
}

function getCarouselScrollBounds(grid: HTMLElement, wrap: HTMLElement) {
  const cards = grid.querySelectorAll('.landing-puzzle-card');
  const first = cards[0];
  const last = cards[cards.length - 1];
  if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return null;

  const fade = getCarouselFadeWidthPx(wrap);
  const minScroll = Math.max(0, first.offsetLeft - fade);
  const maxScroll = last.offsetLeft + last.offsetWidth - (grid.clientWidth - fade);
  return { minScroll, maxScroll: Math.max(minScroll, maxScroll), fade };
}

function clampCarouselScroll(grid: HTMLElement, wrap: HTMLElement) {
  const bounds = getCarouselScrollBounds(grid, wrap);
  if (!bounds) return;

  const { minScroll, maxScroll } = bounds;
  if (grid.scrollLeft < minScroll) {
    grid.scrollLeft = minScroll;
  } else if (grid.scrollLeft > maxScroll) {
    grid.scrollLeft = maxScroll;
  }
}

function scrollCardToCenter(
  grid: HTMLElement,
  wrap: HTMLElement,
  card: HTMLElement,
  behavior: ScrollBehavior = 'auto',
) {
  const bounds = getCarouselScrollBounds(grid, wrap);
  if (!bounds || bounds.maxScroll <= bounds.minScroll) return;

  const { minScroll, maxScroll } = bounds;
  const gridRect = grid.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const cardCenterInViewport = cardRect.left + cardRect.width / 2 - gridRect.left;
  const targetScroll = grid.scrollLeft + cardCenterInViewport - grid.clientWidth / 2;
  grid.scrollTo({
    left: Math.max(minScroll, Math.min(targetScroll, maxScroll)),
    behavior,
  });
  clampCarouselScroll(grid, wrap);
}

const getPuzzlePaths = (puzzleId: string) => ({
  thumbnail: `/puzzles/${puzzleId}/thumbnail.png`,
  fullImage: `/puzzles/${puzzleId}/full-puzzle.jpeg`,
  jsonPath: `/puzzles/${puzzleId}/puzzle.json`,
});

interface PuzzleData {
  id: string;
  name: string;
  thumbnail: string;
  fullImage: string;
}

interface SamplePuzzlesProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSolve: (puzzle: { id: string; name: string; fullImage: string }) => void;
  onPlay: (puzzle: { id: string; name: string }) => void;
  disabled?: boolean;
  onShowToast?: ShowToast;
}

/** Carousel of bundled puzzles with Solve (photo flow) and Play actions. */
export function SamplePuzzles({
  selectedId,
  onSelect,
  onSolve,
  onPlay,
  disabled,
  onShowToast,
}: SamplePuzzlesProps) {
  const [puzzles, setPuzzles] = useState<PuzzleData[]>([]);
  const [loading, setLoading] = useState(true);
  const gridRef = useRef<HTMLDivElement>(null);
  const hasInitialCenteredRef = useRef(false);
  const prevSelectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      hasInitialCenteredRef.current = false;
      prevSelectedIdRef.current = null;
      const results = await Promise.all(
        PUZZLE_IDS.map(async (id) => {
          const paths = getPuzzlePaths(id);
          try {
            const res = await fetch(paths.jsonPath);
            if (!res.ok) throw new Error('');
            const data = await res.json();
            return { id, name: data.name || id, thumbnail: paths.thumbnail, fullImage: data.fullImage || paths.fullImage };
          } catch {
            return { id, name: id, thumbnail: paths.thumbnail, fullImage: paths.fullImage };
          }
        })
      );
      setPuzzles(results);
      setLoading(false);
    };
    void load();
  }, []);

  const centerMiddleCardInCarousel = useCallback((behavior: ScrollBehavior = 'auto') => {
    const grid = gridRef.current;
    const wrap = grid?.parentElement;
    if (!grid || !wrap || !window.matchMedia(NARROW_CAROUSEL_QUERY).matches) return;

    const cards = grid.querySelectorAll('.landing-puzzle-card');
    const middle = cards[Math.floor(cards.length / 2)];
    if (!(middle instanceof HTMLElement)) return;

    scrollCardToCenter(grid, wrap, middle, behavior);
  }, []);

  const centerSelectedInCarousel = useCallback((behavior: ScrollBehavior = 'auto') => {
    const grid = gridRef.current;
    const wrap = grid?.parentElement;
    if (!grid || !wrap || !selectedId || !window.matchMedia(NARROW_CAROUSEL_QUERY).matches) return;

    const card = grid.querySelector(`[data-puzzle-id="${selectedId}"]`);
    if (!(card instanceof HTMLElement)) return;

    scrollCardToCenter(grid, wrap, card, behavior);
  }, [selectedId]);

  const syncCarouselSpacers = useCallback(() => {
    const grid = gridRef.current;
    const wrap = grid?.parentElement;
    if (!grid || !wrap || !window.matchMedia(NARROW_CAROUSEL_QUERY).matches) return;

    const spacers = grid.querySelectorAll('.landing-puzzle-grid-spacer');
    if (spacers.length !== 2) return;

    const fadeSize = getCarouselFadeWidthPx(wrap);
    const gap = parseFloat(getComputedStyle(grid).columnGap || getComputedStyle(grid).gap) || 0;
    const spacerWidth = Math.max(0, fadeSize - gap);
    spacers.forEach((spacer) => {
      if (spacer instanceof HTMLElement) {
        spacer.style.width = `${spacerWidth}px`;
        spacer.style.flexBasis = `${spacerWidth}px`;
      }
    });
    clampCarouselScroll(grid, wrap);
  }, []);

  useLayoutEffect(() => {
    if (loading || puzzles.length === 0) return;

    syncCarouselSpacers();

    if (!hasInitialCenteredRef.current) {
      centerMiddleCardInCarousel('auto');
      hasInitialCenteredRef.current = true;
      prevSelectedIdRef.current = selectedId;
      return;
    }

    if (selectedId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedId;
      if (selectedId) {
        centerSelectedInCarousel('smooth');
      }
    }
  }, [loading, puzzles, selectedId, syncCarouselSpacers, centerMiddleCardInCarousel, centerSelectedInCarousel]);

  useEffect(() => {
    if (loading || puzzles.length === 0) return;

    const grid = gridRef.current;
    const wrap = grid?.parentElement;
    if (!grid || !wrap || !window.matchMedia(NARROW_CAROUSEL_QUERY).matches) return;

    const onScroll = () => clampCarouselScroll(grid, wrap);
    grid.addEventListener('scroll', onScroll, { passive: true });

    const observer = new ResizeObserver(() => {
      syncCarouselSpacers();
    });
    observer.observe(grid);

    return () => {
      grid.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [loading, puzzles, syncCarouselSpacers]);

  const handleSolve = () => {
    if (!selectedId) {
      onShowToast?.('Please select a puzzle first', 'info');
      return;
    }
    const puzzle = puzzles.find((p) => p.id === selectedId);
    if (puzzle) onSolve(puzzle);
  };

  const handlePlay = () => {
    if (!selectedId) {
      onShowToast?.('Please select a puzzle first', 'info');
      return;
    }
    const puzzle = puzzles.find((p) => p.id === selectedId);
    if (puzzle) onPlay(puzzle);
  };

  return (
    <section id="examples" className="landing-sample-section">
      <div className="landing-section-header">
        <h2>Try a Sample Puzzle</h2>
        <p>Choose one of these to solve or play interactively.</p>
      </div>
      <div className="landing-puzzle-grid-wrap">
        <div ref={gridRef} className="landing-puzzle-grid">
          {loading ? (
            <div className="landing-puzzle-grid-loading">Loading puzzles...</div>
          ) : (
            <>
              <div className="landing-puzzle-grid-spacer" aria-hidden="true" />
              {puzzles.map((p) => (
                <PuzzleCard
                  key={p.id}
                  id={p.id}
                  name={p.name}
                  fullImage={p.fullImage}
                  selected={selectedId === p.id}
                  onSelect={() => onSelect(p.id)}
                />
              ))}
              <div className="landing-puzzle-grid-spacer" aria-hidden="true" />
            </>
          )}
        </div>
      </div>
      <div className="landing-sample-actions">
        <button
          type="button"
          className="landing-sample-btn landing-solve-btn"
          onClick={handleSolve}
          disabled={disabled || !selectedId}
        >
          Solve Sample Puzzle
        </button>
        <button
          type="button"
          className="landing-sample-btn landing-play-btn"
          onClick={() => handlePlay()}
          disabled={disabled || !selectedId}
        >
          Try the puzzle
        </button>
      </div>
    </section>
  );
}
