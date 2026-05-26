import { useState, useEffect } from 'react';
import { PuzzleCard } from './PuzzleCard';
import type { ShowToast } from '../../types/ui';

const PUZZLE_IDS = ['puzzle1', 'puzzle2', 'puzzle3', 'puzzle4', 'puzzle5'];

const getPuzzlePaths = (puzzleId: string) => ({
  thumbnail: `/puzzles/${puzzleId}/piece0.png`,
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

  useEffect(() => {
    const load = async () => {
      setLoading(true);
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
      <div className="landing-puzzle-grid">
        {loading ? (
          <div style={{ gridColumn: '1 / -1', color: 'var(--landing-text-muted)' }}>Loading puzzles...</div>
        ) : (
          puzzles.map((p) => (
            <PuzzleCard
              key={p.id}
              id={p.id}
              name={p.name}
              fullImage={p.fullImage}
              selected={selectedId === p.id}
              onSelect={() => onSelect(p.id)}
            />
          ))
        )}
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
