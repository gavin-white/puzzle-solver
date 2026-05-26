interface PuzzleCardProps {
  id: string;
  name: string;
  fullImage: string;
  selected: boolean;
  onSelect: () => void;
}

/** Selectable thumbnail card for one sample puzzle. */
export function PuzzleCard({ id, name, selected, onSelect }: PuzzleCardProps) {
  const thumbnailSrc = `/puzzles/${id}/thumbnail.png`;
  return (
    <button
      type="button"
      className={`landing-puzzle-card ${selected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="landing-puzzle-card-thumb">
        <img src={thumbnailSrc} alt={name} />
      </div>
      <span className="landing-puzzle-card-name">{name}</span>
    </button>
  );
}
