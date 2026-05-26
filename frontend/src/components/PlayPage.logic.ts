import type { PuzzleInfoData, SolutionData } from '../types';
import type { BoardState, PieceState } from './PlayPage.types';

export type PuzzleInfo = PuzzleInfoData;
export type Solution = PieceState[];

export interface PuzzleJson {
  name: string;
  fullImage?: string;
  pieces: Record<string, number[]>;
  matches: Record<string, number>;
}

/** Convert API quarter-turn index (0-3) to clockwise degrees for rendering. */
export const apiRotationToDegrees = (apiRotation: number): number =>
  ((4 - (apiRotation % 4)) % 4) * 90;

export const degreesToApiRotation = (degrees: number): number => {
  const normalized = (((degrees % 360) + 360) % 360) / 90;
  return (4 - normalized) % 4;
};

export const getPieceImageUrl = (puzzleId: string, pieceId: number): string => {
  return `/puzzles/${puzzleId}/piece${pieceId}.png`;
};

/** Place pieces on a 9-cell array from `/api/solve`-style maps. */
export const solutionDataToBoard = (solutionData: SolutionData): Solution => {
  const board: (PieceState | null)[] = new Array(9).fill(null);

  for (const [pieceIdStr, position] of Object.entries(solutionData.positions)) {
    const pieceId = parseInt(pieceIdStr, 10);
    const apiRotation = solutionData.rotations[pieceIdStr] ?? 0;
    const rotation = apiRotationToDegrees(apiRotation);
    board[position] = { pieceId, rotation };
  }

  return board.filter((p): p is PieceState => p !== null);
};

/** True when every cell matches the reference solution's piece id and rotation. */
export const boardMatchesSolution = (board: BoardState, solution: Solution): boolean => {
  if (solution.length !== 9) return false;

  for (let i = 0; i < 9; i++) {
    const boardPiece = board[i];
    const solutionPiece = solution[i];

    if (!boardPiece || !solutionPiece) return false;
    if (boardPiece.pieceId !== solutionPiece.pieceId) return false;

    const boardNormalized = ((boardPiece.rotation % 360) + 360) % 360;
    const solutionNormalized = ((solutionPiece.rotation % 360) + 360) % 360;
    if (boardNormalized !== solutionNormalized) return false;
  }

  return true;
};

/** True if the board equals any known valid solution. */
export const isBoardSolved = (board: BoardState, solutions: Solution[]): boolean => {
  return solutions.some((solution) => boardMatchesSolution(board, solution));
};

/** Serialize the board into `SolveRequest.currentPlacements` fields. */
export function buildCurrentPlacements(board: BoardState) {
  const currentPositions: Record<string, number> = {};
  const currentRotations: Record<string, number> = {};
  board.forEach((piece, index) => {
    if (piece) {
      const pieceIdStr = piece.pieceId.toString();
      currentPositions[pieceIdStr] = index;
      currentRotations[pieceIdStr] = degreesToApiRotation(piece.rotation);
    }
  });
  return { currentPositions, currentRotations };
}

/** Delta in degrees to the nearest equivalent angle mod 360. */
export function findShortestRotation(currentRotation: number, targetRotation: number): number {
  const currentNormalized = ((currentRotation % 360) + 360) % 360;
  const targetNormalized = ((targetRotation % 360) + 360) % 360;
  let diff = targetNormalized - currentNormalized;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return currentRotation + diff;
}
