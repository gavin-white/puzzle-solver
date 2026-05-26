/**
 * Shared shapes for `PlayPage` and its drag/animation hooks (board cells and overlays).
 */
export interface PieceState {
  pieceId: number;
  rotation: number;
}

/** Piece sitting in the off-board tray with absolute coordinates. */
export interface FreePiece extends PieceState {
  x: number;
  y: number;
}

/** Nine slots; `null` is an empty grid cell. */
export type BoardState = (PieceState | null)[];

/** Active pointer drag payload (board or free-tray source). */
export interface DraggingPiece {
  piece: PieceState;
  source: 'board' | 'free';
  sourceIndex: number;
  offsetX: number;
  offsetY: number;
  left: number;
  top: number;
}

/** One piece’s start/end pose for the solve animation overlay. */
export interface AnimatingPiece {
  pieceId: number;
  startX: number;
  startY: number;
  startRotation: number;
  endX: number;
  endY: number;
  endRotation: number;
}
