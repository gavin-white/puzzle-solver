/**
 * Pointer-driven drag for Play mode: lift pieces from board or tray, hover cells, drop.
 */
import { useState, useCallback, useEffect } from 'react';
import type { PieceState, FreePiece, BoardState, DraggingPiece } from '../components/PlayPage.types';

/** Wire board + free-tray refs and state setters; returns drag handlers and hover cell. */
export function useDragAndDrop(
  board: BoardState,
  setBoard: React.Dispatch<React.SetStateAction<BoardState>>,
  freePieces: FreePiece[],
  setFreePieces: React.Dispatch<React.SetStateAction<FreePiece[]>>,
  boardRef: React.RefObject<HTMLDivElement | null>,
  gameAreaRef: React.RefObject<HTMLDivElement | null>,
) {
  const [draggingPiece, setDraggingPiece] = useState<DraggingPiece | null>(null);
  const [hoveredCell, setHoveredCell] = useState<number | null>(null);

  const getPieceSize = useCallback(() => {
    if (!boardRef.current) return 100;
    return boardRef.current.offsetWidth / 3;
  }, [boardRef]);

  const handleBoardPointerDown = useCallback((e: React.PointerEvent, index: number, piece: PieceState) => {
    e.preventDefault();
    const gameAreaRect = gameAreaRef.current?.getBoundingClientRect();
    const pieceRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!gameAreaRect) return;

    setDraggingPiece({
      piece,
      source: 'board',
      sourceIndex: index,
      offsetX: e.clientX - pieceRect.left,
      offsetY: e.clientY - pieceRect.top,
      left: pieceRect.left - gameAreaRect.left,
      top: pieceRect.top - gameAreaRect.top,
    });
  }, [gameAreaRef]);

  const handleFreePointerDown = useCallback((e: React.PointerEvent, index: number, piece: FreePiece) => {
    e.preventDefault();
    const gameAreaRect = gameAreaRef.current?.getBoundingClientRect();
    const pieceRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!gameAreaRect) return;

    setFreePieces(prev => {
      const newPieces = prev.filter((_, i) => i !== index);
      return [...newPieces, piece];
    });
    setDraggingPiece({
      piece,
      source: 'free',
      sourceIndex: freePieces.length - 1,
      offsetX: e.clientX - pieceRect.left,
      offsetY: e.clientY - pieceRect.top,
      left: pieceRect.left - gameAreaRect.left,
      top: pieceRect.top - gameAreaRect.top,
    });
  }, [gameAreaRef, freePieces.length, setFreePieces]);

  useEffect(() => {
    if (!draggingPiece) return;

    const handlePointerMove = (e: PointerEvent) => {
      const gameAreaRect = gameAreaRef.current?.getBoundingClientRect();
      if (!gameAreaRect) return;

      setDraggingPiece(prev => {
        if (!prev) return null;
        return {
          ...prev,
          left: e.clientX - gameAreaRect.left - prev.offsetX,
          top: e.clientY - gameAreaRect.top - prev.offsetY,
        };
      });

      if (boardRef.current) {
        const boardRect = boardRef.current.getBoundingClientRect();
        const cellSize = boardRect.width / 3;
        const relX = e.clientX - boardRect.left;
        const relY = e.clientY - boardRect.top;

        if (relX >= 0 && relX < boardRect.width && relY >= 0 && relY < boardRect.height) {
          const col = Math.floor(relX / cellSize);
          const row = Math.floor(relY / cellSize);
          setHoveredCell(row * 3 + col);
        } else {
          setHoveredCell(null);
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!draggingPiece || !gameAreaRef.current) {
        setDraggingPiece(null);
        setHoveredCell(null);
        return;
      }

      const gameAreaRect = gameAreaRef.current.getBoundingClientRect();
      const pieceSize = getPieceSize();

      if (boardRef.current) {
        const boardRect = boardRef.current.getBoundingClientRect();
        const cellSize = boardRect.width / 3;
        const relX = e.clientX - boardRect.left;
        const relY = e.clientY - boardRect.top;

        if (relX >= 0 && relX < boardRect.width && relY >= 0 && relY < boardRect.height) {
          const col = Math.floor(relX / cellSize);
          const row = Math.floor(relY / cellSize);
          const cellIndex = row * 3 + col;

          const existingPiece = board[cellIndex];

          if (draggingPiece.source === 'board') {
            setBoard(prevBoard => {
              const newBoard = [...prevBoard];
              newBoard[cellIndex] = prevBoard[draggingPiece.sourceIndex];
              newBoard[draggingPiece.sourceIndex] = existingPiece;
              return newBoard;
            });
          } else {
            const currentPiece = freePieces.find(p => p.pieceId === draggingPiece.piece.pieceId);
            if (currentPiece) {
              setBoard(prevBoard => {
                const newBoard = [...prevBoard];
                newBoard[cellIndex] = { pieceId: currentPiece.pieceId, rotation: currentPiece.rotation };
                return newBoard;
              });
              setFreePieces(prev => prev.filter(p => p.pieceId !== currentPiece.pieceId));

              if (existingPiece) {
                const dropX = ((e.clientX - gameAreaRect.left - pieceSize / 2) / gameAreaRect.width) * 100;
                const dropY = ((e.clientY - gameAreaRect.top - pieceSize / 2) / gameAreaRect.height) * 100;
                setFreePieces(prev => [...prev, { ...existingPiece, x: dropX, y: dropY }]);
              }
            }
          }

          setDraggingPiece(null);
          setHoveredCell(null);
          return;
        }
      }

      const dropX = ((e.clientX - gameAreaRect.left - draggingPiece.offsetX) / gameAreaRect.width) * 100;
      const dropY = ((e.clientY - gameAreaRect.top - draggingPiece.offsetY) / gameAreaRect.height) * 100;

      const clampedX = Math.max(0, Math.min(dropX, 100 - (pieceSize / gameAreaRect.width) * 100));
      const clampedY = Math.max(0, Math.min(dropY, 100 - (pieceSize / gameAreaRect.height) * 100));

      if (draggingPiece.source === 'board') {
        const piece = board[draggingPiece.sourceIndex];
        if (piece) {
          setBoard(prevBoard => {
            const newBoard = [...prevBoard];
            newBoard[draggingPiece.sourceIndex] = null;
            return newBoard;
          });
          setFreePieces(prev => [...prev, { ...piece, x: clampedX, y: clampedY }]);
        }
      } else {
        setFreePieces(prev => prev.map(p =>
          p.pieceId === draggingPiece.piece.pieceId
            ? { ...p, x: clampedX, y: clampedY }
            : p
        ));
      }

      setDraggingPiece(null);
      setHoveredCell(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggingPiece, board, freePieces, getPieceSize, boardRef, gameAreaRef, setBoard, setFreePieces]);

  const handleRotate = useCallback((source: 'board' | 'free', index: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (source === 'board') {
      setBoard(prevBoard => {
        const newBoard = [...prevBoard];
        const piece = newBoard[index];
        if (piece) {
          newBoard[index] = { ...piece, rotation: piece.rotation + 90 };
        }
        return newBoard;
      });
    } else {
      setFreePieces(prev => prev.map((p, i) =>
        i === index ? { ...p, rotation: p.rotation + 90 } : p
      ));
    }
  }, [setBoard, setFreePieces]);

  const handleShuffle = useCallback(() => {
    const allPieces: PieceState[] = [
      ...board.filter((p): p is PieceState => p !== null),
      ...freePieces.map(p => ({ pieceId: p.pieceId, rotation: p.rotation }))
    ];

    const existingIds = new Set(allPieces.map(p => p.pieceId));
    for (let i = 0; i < 9; i++) {
      if (!existingIds.has(i)) {
        allPieces.push({ pieceId: i, rotation: 0 });
      }
    }

    for (let i = allPieces.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allPieces[i], allPieces[j]] = [allPieces[j], allPieces[i]];
    }

    const shuffledPieces = allPieces.map(p => ({
      ...p,
      rotation: Math.floor(Math.random() * 4) * 90
    }));

    setBoard(shuffledPieces.slice(0, 9));
    setFreePieces([]);
  }, [board, freePieces, setBoard, setFreePieces]);

  return {
    draggingPiece,
    hoveredCell,
    getPieceSize,
    handleBoardPointerDown,
    handleFreePointerDown,
    handleRotate,
    handleShuffle,
  };
}
