/**
 * Interactive 3×3 board for bundled sample puzzles: drag/drop, hints, animated solve.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import './PlayPage.css';
import { ApiService } from '../services/api';
import { useDragAndDrop } from '../hooks/useDragAndDrop';
import { usePieceAnimation } from '../hooks/usePieceAnimation';
import type { SolveRequest } from '../types';
import type { ShowToast } from '../types/ui';
import { userMessageFromError } from '../utils/errors';
import type { FreePiece, BoardState, AnimatingPiece } from './PlayPage.types';
import {
  apiRotationToDegrees,
  buildCurrentPlacements,
  findShortestRotation,
  getPieceImageUrl,
  isBoardSolved,
  solutionDataToBoard,
  type PuzzleInfo,
  type PuzzleJson,
  type Solution,
} from './PlayPage.logic';

interface PlayPageProps {
  puzzleId: string | null;
  puzzleName: string | null;
  onBack: () => void;
  onShowToast?: ShowToast;
}

const rotationToDegrees = (rotation: number): number => rotation;

const loadedPieceUrls = new Set<string>();

interface PieceImageProps {
  puzzleId: string;
  pieceId: number;
  rotation: number;
  className?: string;
}

/** Piece artwork with a neutral placeholder until the image finishes loading. */
function PieceImage({ puzzleId, pieceId, rotation, className = 'piece-image' }: PieceImageProps) {
  const src = getPieceImageUrl(puzzleId, pieceId);
  const [loaded, setLoaded] = useState(() => loadedPieceUrls.has(src));

  return (
    <img
      src={src}
      alt=""
      decoding="async"
      className={`${className}${loaded ? ' piece-image-loaded' : ''}`}
      style={{ transform: `rotate(${rotation}deg)` }}
      draggable={false}
      onLoad={() => {
        loadedPieceUrls.add(src);
        setLoaded(true);
      }}
    />
  );
}

/** Load bundled puzzle JSON, manage board state, hints/solve, and win detection. */
export function PlayPage({ puzzleId, puzzleName, onBack, onShowToast }: PlayPageProps) {
  const [board, setBoard] = useState<BoardState>(() =>
    Array.from({ length: 9 }, (_, i) => ({ pieceId: i, rotation: 0 }))
  );
  const [freePieces, setFreePieces] = useState<FreePiece[]>([]);

  const [puzzleInfo, setPuzzleInfo] = useState<PuzzleInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  const [puzzleData, setPuzzleData] = useState<PuzzleJson | null>(null);
  const [puzzleDataLoading, setPuzzleDataLoading] = useState(false);
  const [puzzleDataError, setPuzzleDataError] = useState<string | null>(null);

  const [solutions, setSolutions] = useState<Solution[]>([]);

  const [solveLoading, setSolveLoading] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);

  const isSolved = isBoardSolved(board, solutions);

  const [hintLoading, setHintLoading] = useState(false);
  const [hintError, setHintError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const gameAreaRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const drag = useDragAndDrop(board, setBoard, freePieces, setFreePieces, boardRef, gameAreaRef);
  const animation = usePieceAnimation();

  const findDisplacedPiecePosition = useCallback((
    existingFreePieces: FreePiece[],
    boardPosition: number
  ): { x: number; y: number } => {
    const pieceSize = 12;
    const col = boardPosition % 3;
    const row = Math.floor(boardPosition / 3);
    const rowYPositions = [18, 40, 62];
    const preferredY = rowYPositions[row];
    const preferLeft = col === 0;
    const preferRight = col === 2;
    const leftX = 3;
    const rightX = 85;

    const hasOverlap = (x: number, y: number) => {
      return existingFreePieces.some(p =>
        Math.abs(p.x - x) < pieceSize && Math.abs(p.y - y) < pieceSize
      );
    };

    const findSlotOnSide = (baseX: number, startY: number): { x: number; y: number } | null => {
      if (!hasOverlap(baseX, startY)) {
        return { x: baseX, y: startY };
      }
      const minY = 5;
      const maxY = 85;
      for (let offset = pieceSize + 2; offset < 80; offset += pieceSize + 2) {
        const yAbove = startY - offset;
        if (yAbove >= minY && !hasOverlap(baseX, yAbove)) return { x: baseX, y: yAbove };
        const yBelow = startY + offset;
        if (yBelow <= maxY && !hasOverlap(baseX, yBelow)) return { x: baseX, y: yBelow };
      }
      return null;
    };

    if (preferLeft || (!preferRight)) {
      const leftSlot = findSlotOnSide(leftX, preferredY);
      if (leftSlot) return leftSlot;
      const rightSlot = findSlotOnSide(rightX, preferredY);
      if (rightSlot) return rightSlot;
    } else {
      const rightSlot = findSlotOnSide(rightX, preferredY);
      if (rightSlot) return rightSlot;
      const leftSlot = findSlotOnSide(leftX, preferredY);
      if (leftSlot) return leftSlot;
    }

    return { x: leftX + Math.random() * 5, y: 5 + Math.random() * 10 };
  }, []);

  const applyHintDirectly = useCallback((pieceId: number, position: number, rotation: number) => {
    const newBoard = [...board];
    const newFreePieces = [...freePieces];

    const displacedPiece = newBoard[position];
    if (displacedPiece && displacedPiece.pieceId !== pieceId) {
      const displacedPos = findDisplacedPiecePosition(newFreePieces, position);
      newFreePieces.push({ pieceId: displacedPiece.pieceId, rotation: displacedPiece.rotation, x: displacedPos.x, y: displacedPos.y });
    }

    const boardIndex = newBoard.findIndex(p => p?.pieceId === pieceId);
    if (boardIndex >= 0) newBoard[boardIndex] = null;
    const freeIndex = newFreePieces.findIndex(p => p.pieceId === pieceId);
    if (freeIndex >= 0) newFreePieces.splice(freeIndex, 1);

    newBoard[position] = { pieceId, rotation };
    setBoard(newBoard);
    setFreePieces(newFreePieces);
  }, [board, freePieces, findDisplacedPiecePosition]);

  const locatePiece = useCallback((
    targetPieceId: number,
    boardRect: DOMRect,
    gameAreaRect: DOMRect,
    cellSize: number,
  ): { x: number; y: number; rotation: number; onBoard: boolean; boardIndex: number; freeIndex: number } => {
    let x = 0, y = 0, rotation = 0, onBoard = false, boardIndex = -1, freeIndex = -1;

    board.forEach((piece, index) => {
      if (piece && piece.pieceId === targetPieceId) {
        const col = index % 3;
        const row = Math.floor(index / 3);
        x = boardRect.left - gameAreaRect.left + col * cellSize;
        y = boardRect.top - gameAreaRect.top + row * cellSize;
        rotation = piece.rotation;
        onBoard = true;
        boardIndex = index;
      }
    });

    if (!onBoard) {
      freePieces.forEach((piece, index) => {
        if (piece.pieceId === targetPieceId) {
          x = (piece.x / 100) * gameAreaRect.width;
          y = (piece.y / 100) * gameAreaRect.height;
          rotation = piece.rotation;
          freeIndex = index;
        }
      });
    }

    return { x, y, rotation, onBoard, boardIndex, freeIndex };
  }, [board, freePieces]);

  const handleHint = useCallback(async () => {
    if (!puzzleData || !boardRef.current) {
      onShowToast?.('Puzzle data not available', 'error');
      return;
    }
    if (isSolved) return;

    setHintLoading(true);
    setHintError(null);

    try {
      const hintRequest: SolveRequest = {
        pieces: puzzleData.pieces,
        matches: puzzleData.matches,
        currentPlacements: buildCurrentPlacements(board),
      };

      const hint = await ApiService.getHint(hintRequest);
      const hintPieceId = parseInt(hint.piece, 10);
      const targetPosition = hint.position;
      const targetRotation = apiRotationToDegrees(hint.rotation);

      const boardRect = boardRef.current.getBoundingClientRect();
      const cellSize = boardRect.width / 3;
      const gameAreaRect = gameAreaRef.current?.getBoundingClientRect();

      if (!gameAreaRect) {
        applyHintDirectly(hintPieceId, targetPosition, targetRotation);
        return;
      }

      const source = locatePiece(hintPieceId, boardRect, gameAreaRect, cellSize);

      const targetCol = targetPosition % 3;
      const targetRow = Math.floor(targetPosition / 3);
      const endX = boardRect.left - gameAreaRect.left + targetCol * cellSize;
      const endY = boardRect.top - gameAreaRect.top + targetRow * cellSize;
      const endRotation = findShortestRotation(source.rotation, targetRotation);

      const animPiece: AnimatingPiece = {
        pieceId: hintPieceId,
        startX: source.x, startY: source.y, startRotation: source.rotation,
        endX, endY, endRotation,
      };

      const newBoard = [...board];
      const newFreePieces = [...freePieces];

      const displacedPiece = newBoard[targetPosition];
      if (displacedPiece && displacedPiece.pieceId !== hintPieceId) {
        const displacedPos = findDisplacedPiecePosition(newFreePieces, targetPosition);
        newFreePieces.push({ pieceId: displacedPiece.pieceId, rotation: displacedPiece.rotation, x: displacedPos.x, y: displacedPos.y });
      }

      if (source.onBoard && source.boardIndex >= 0) newBoard[source.boardIndex] = null;
      if (!source.onBoard && source.freeIndex >= 0) {
        const idx = newFreePieces.findIndex(p => p.pieceId === hintPieceId);
        if (idx >= 0) newFreePieces.splice(idx, 1);
      }

      newBoard[targetPosition] = { pieceId: hintPieceId, rotation: targetRotation };

      animation.animate([animPiece], () => {
        setBoard(newBoard);
        setFreePieces(newFreePieces);
      });

    } catch (error) {
      const message = userMessageFromError(error, 'Unable to get a hint right now. Please try again.');
      setHintError(message);
      onShowToast?.(message, 'error');
    } finally {
      setHintLoading(false);
    }
  }, [puzzleData, board, freePieces, findDisplacedPiecePosition, locatePiece, isSolved, onShowToast, applyHintDirectly, animation]);

  const handleSolve = useCallback(async () => {
    if (!puzzleData || !boardRef.current) {
      onShowToast?.('Puzzle data not available', 'error');
      return;
    }
    if (isSolved) return;

    setSolveLoading(true);
    setSolveError(null);

    try {
      const solveRequest: SolveRequest = {
        pieces: puzzleData.pieces,
        matches: puzzleData.matches,
        currentPlacements: buildCurrentPlacements(board),
      };

      const response = await ApiService.solvePuzzle(solveRequest);

      const allSolutions = response.solutions.map(solutionDataToBoard);
      setSolutions(allSolutions);

      const bestSolution = solutionDataToBoard(response.bestSolution);

      const boardRect = boardRef.current.getBoundingClientRect();
      const cellSize = boardRect.width / 3;
      const gameAreaRect = gameAreaRef.current?.getBoundingClientRect();

      if (!gameAreaRect) {
        setBoard(bestSolution);
        setFreePieces([]);
        return;
      }

      const currentPixelPositions = new Map<number, { x: number; y: number; rotation: number }>();
      board.forEach((piece, index) => {
        if (piece) {
          const col = index % 3;
          const row = Math.floor(index / 3);
          currentPixelPositions.set(piece.pieceId, {
            x: boardRect.left - gameAreaRect.left + col * cellSize,
            y: boardRect.top - gameAreaRect.top + row * cellSize,
            rotation: piece.rotation,
          });
        }
      });
      freePieces.forEach(piece => {
        currentPixelPositions.set(piece.pieceId, {
          x: (piece.x / 100) * gameAreaRect.width,
          y: (piece.y / 100) * gameAreaRect.height,
          rotation: piece.rotation,
        });
      });

      const animPieces: AnimatingPiece[] = [];
      bestSolution.forEach((targetPiece, targetIndex) => {
        const current = currentPixelPositions.get(targetPiece.pieceId) || { x: 0, y: 0, rotation: 0 };
        const targetCol = targetIndex % 3;
        const targetRow = Math.floor(targetIndex / 3);
        const targetX = boardRect.left - gameAreaRect.left + targetCol * cellSize;
        const targetY = boardRect.top - gameAreaRect.top + targetRow * cellSize;

        const endRotation = findShortestRotation(current.rotation, targetPiece.rotation);

        const needsMove = Math.abs(current.x - targetX) > 1 || Math.abs(current.y - targetY) > 1;
        const needsRotate = Math.abs(endRotation - current.rotation) > 1;

        if (needsMove || needsRotate) {
          animPieces.push({
            pieceId: targetPiece.pieceId,
            startX: current.x, startY: current.y, startRotation: current.rotation,
            endX: targetX, endY: targetY, endRotation,
          });
        }
      });

      animation.animate(animPieces, () => {
        setBoard(bestSolution);
        setFreePieces([]);
      });

    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      const noSolution = /unable to find solution|no solution/i.test(rawMessage);
      const message = noSolution
        ? 'Unable to find a solution for this puzzle.'
        : userMessageFromError(error, 'Unable to solve the puzzle right now. Please try again.');
      setSolveError(message);
      onShowToast?.(message, 'error');
    } finally {
      setSolveLoading(false);
    }
  }, [puzzleData, board, freePieces, isSolved, onShowToast, animation]);

  useEffect(() => {
    if (!puzzleId) return;
    const links: HTMLLinkElement[] = [];
    for (let pieceId = 0; pieceId < 9; pieceId++) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = getPieceImageUrl(puzzleId, pieceId);
      document.head.appendChild(link);
      links.push(link);
    }
    return () => {
      links.forEach((link) => link.remove());
    };
  }, [puzzleId]);

  useEffect(() => {
    if (!puzzleId) return;
    const loadPuzzleData = async () => {
      setPuzzleDataLoading(true);
      setPuzzleDataError(null);
      try {
        const jsonResponse = await fetch(`/puzzles/${puzzleId}/puzzle.json`);
        if (!jsonResponse.ok) throw new Error(`Failed to load puzzle data: ${jsonResponse.statusText}`);
        const data: PuzzleJson = await jsonResponse.json();
        setPuzzleData(data);
      } catch (error) {
        setPuzzleDataError(userMessageFromError(error, 'Failed to load puzzle data'));
        setPuzzleData(null);
      } finally {
        setPuzzleDataLoading(false);
      }
    };
    void loadPuzzleData();
  }, [puzzleId]);

  useEffect(() => {
    if (!puzzleData) return;
    const fetchPuzzleInfoAndSolutions = async () => {
      setInfoLoading(true);
      try {
        const infoRequest: SolveRequest = { pieces: puzzleData.pieces, matches: puzzleData.matches };
        const response = await ApiService.getPuzzleInfo(infoRequest);
        setSolutions(response.solutions.map(solutionDataToBoard));
        setPuzzleInfo(response.info);
      } catch (error) {
        setSolutions([]);
        setPuzzleInfo(null);
        onShowToast?.(
          userMessageFromError(error, 'Unable to load puzzle solution info right now.'),
          'error'
        );
      } finally {
        setInfoLoading(false);
      }
    };
    void fetchPuzzleInfoAndSolutions();
  }, [puzzleData, onShowToast]);

  if (!puzzleId) {
    return (
      <div className="play-page">
        <div className="play-page-content">
          <h2>No Puzzle Selected</h2>
          <p>Please go back and select a puzzle to play.</p>
          <button onClick={onBack} className="action-button back-button">
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  const pieceSize = drag.getPieceSize();

  return (
    <div className="play-page">
      <div className="game-container" ref={containerRef}>
        <h2 className="board-title">{puzzleName || 'Puzzle'}</h2>

        <div className="game-area" ref={gameAreaRef}>
          <div className={`board-grid ${isSolved ? 'solved' : ''}`} ref={boardRef}>
            {board.map((piece, index) => (
              <div
                key={index}
                className={`board-cell ${drag.hoveredCell === index ? 'cell-hover' : ''} ${piece ? 'has-piece' : 'empty'}`}
              >
                {piece && !animation.animatingPieces.some(ap => ap.pieceId === piece.pieceId) && !(drag.draggingPiece?.source === 'board' && drag.draggingPiece?.sourceIndex === index) && (
                  <div
                    key={piece.pieceId}
                    className="puzzle-piece"
                    onPointerDown={(e) => drag.handleBoardPointerDown(e, index, piece)}
                  >
                    <PieceImage
                      puzzleId={puzzleId}
                      pieceId={piece.pieceId}
                      rotation={rotationToDegrees(piece.rotation)}
                    />
                    <button
                      className="rotate-button"
                      onPointerDown={(e) => drag.handleRotate('board', index, e)}
                      title="Rotate piece"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M23 4v6h-6"/>
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {freePieces.map((piece, index) => (
            !animation.animatingPieces.some(ap => ap.pieceId === piece.pieceId) &&
            !(drag.draggingPiece?.source === 'free' && drag.draggingPiece?.piece.pieceId === piece.pieceId) && (
              <div
                key={piece.pieceId}
                className="free-piece"
                style={{ left: `${piece.x}%`, top: `${piece.y}%`, width: pieceSize, height: pieceSize }}
                onPointerDown={(e) => drag.handleFreePointerDown(e, index, piece)}
              >
                <PieceImage
                  puzzleId={puzzleId}
                  pieceId={piece.pieceId}
                  rotation={rotationToDegrees(piece.rotation)}
                />
                <button
                  className="rotate-button"
                  onPointerDown={(e) => drag.handleRotate('free', index, e)}
                  title="Rotate piece"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                </button>
              </div>
            )
          ))}

          {drag.draggingPiece && (
            <div
              className="dragging-piece"
              style={{ left: drag.draggingPiece.left, top: drag.draggingPiece.top, width: pieceSize, height: pieceSize }}
            >
              <PieceImage
                puzzleId={puzzleId}
                pieceId={drag.draggingPiece.piece.pieceId}
                rotation={rotationToDegrees(drag.draggingPiece.piece.rotation)}
              />
            </div>
          )}

          {animation.isAnimating && animation.animatingPieces.map((piece) => {
            const x = animation.animationProgress === 0 ? piece.startX : piece.endX;
            const y = animation.animationProgress === 0 ? piece.startY : piece.endY;
            const rotation = animation.animationProgress === 0 ? piece.startRotation : piece.endRotation;

            return (
              <div
                key={piece.pieceId}
                className="animating-piece"
                style={{ left: x, top: y, width: pieceSize, height: pieceSize }}
              >
                <PieceImage
                  puzzleId={puzzleId}
                  pieceId={piece.pieceId}
                  rotation={rotation}
                  className="piece-image animating-image"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="info-section">
        {infoLoading ? (
          <div className="info-loading">Loading puzzle information...</div>
        ) : puzzleInfo ? (
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">Difficulty</span>
              <span className="info-value">{puzzleInfo.difficulty}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Valid 2x2 Combinations</span>
              <span className="info-value">{puzzleInfo.numValidQuads}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Solutions</span>
              <span className="info-value">{puzzleInfo.numSolutions}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Unique Solutions</span>
              <span className="info-value">{puzzleInfo.numUniqueSolutions}</span>
            </div>
          </div>
        ) : (
          <div className="info-error">Unable to load puzzle information</div>
        )}
      </div>

      <div className="play-controls">
        <button onClick={drag.handleShuffle} className="action-button shuffle-button">
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 3h5v5"/>
            <path d="M4 20L21 3"/>
            <path d="M21 16v5h-5"/>
            <path d="M15 15l6 6"/>
            <path d="M4 4l5 5"/>
          </svg>
          Shuffle
        </button>
        <button
          onClick={() => void handleHint()}
          className={`action-button hint-button ${!puzzleData && !puzzleDataLoading && !hintLoading && !animation.isAnimating ? 'button-disabled-visual' : ''}`}
          disabled={puzzleDataLoading || hintLoading || animation.isAnimating}
          title={!puzzleData ? 'Puzzle data not available' : hintError || ''}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" strokeLinecap="round"/>
            <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" strokeWidth="3"/>
          </svg>
          Hint
        </button>
        <button
          onClick={() => void handleSolve()}
          className={`action-button solve-button ${!puzzleData && !puzzleDataLoading && !solveLoading && !animation.isAnimating ? 'button-disabled-visual' : ''}`}
          disabled={puzzleDataLoading || solveLoading || animation.isAnimating}
          title={!puzzleData ? 'Puzzle data not available' : puzzleDataError || solveError || ''}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          Solve
        </button>
      </div>
    </div>
  );
}
