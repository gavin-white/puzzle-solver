import { useState, useEffect, useMemo, useRef } from 'react';
import type { SubmittedData, PuzzleInfoResponse } from '../types';
import './SolvePage.css';

interface SolvePageProps {
  submittedData: SubmittedData;
  puzzleInfoResponse: PuzzleInfoResponse;
  onBack: () => void;
  onStartOver: () => void;
}

/** Post-solve summary: original vs arranged pieces, optional labels, puzzle stats. */
export function SolvePage({ submittedData, puzzleInfoResponse, onBack, onStartOver }: SolvePageProps) {
  const { submitResponse, imageUrl, boundingBoxes, pieceIndexMap } = submittedData;
  const images = submitResponse?.images || [];
  const pieces = submitResponse?.pieces || [];
  const pieceTriangles = submitResponse?.pieceTriangles || {};
  
  const [showLabels, setShowLabels] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  const cropBounds = useMemo(() => {
    if (boundingBoxes.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    boundingBoxes.forEach((box) => {
      const corners = [box.topLeft, box.topRight, box.bottomLeft, box.bottomRight];
      corners.forEach((corner) => {
        minX = Math.min(minX, corner.x);
        minY = Math.min(minY, corner.y);
        maxX = Math.max(maxX, corner.x);
        maxY = Math.max(maxY, corner.y);
      });
    });

    const padding = Math.min((maxX - minX) * 0.05, (maxY - minY) * 0.05, 20);
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = maxX + padding;
    maxY = maxY + padding;

    return {
      minX,
      minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [boundingBoxes]);

  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  
  useEffect(() => {
    if (!imageUrl) return;
    
    let isCancelled = false;
    
    const img = new Image();
    img.onload = () => {
      if (!isCancelled) {
        setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
      }
    };
    img.src = imageUrl;
    
    return () => {
      isCancelled = true;
      img.onload = null;
    };
  }, [imageUrl]);

  const originalPieceLabels = useMemo(() => {
    if (!cropBounds || !pieceIndexMap) return [];
    
    const labels: Array<{ pieceIndex: number; centerXPercent: number; centerYPercent: number }> = [];
    
    boundingBoxes.forEach((box, boundingBoxIndex) => {
      let pieceIndex: number | null = null;
      pieceIndexMap.forEach((bbIndex, pIndex) => {
        if (bbIndex === boundingBoxIndex) {
          pieceIndex = pIndex;
        }
      });

      if (pieceIndex === null) return;

      const boxMinX = Math.min(box.topLeft.x, box.topRight.x, box.bottomLeft.x, box.bottomRight.x);
      const boxMinY = Math.min(box.topLeft.y, box.topRight.y, box.bottomLeft.y, box.bottomRight.y);
      const boxMaxX = Math.max(box.topLeft.x, box.topRight.x, box.bottomLeft.x, box.bottomRight.x);
      const boxMaxY = Math.max(box.topLeft.y, box.topRight.y, box.bottomLeft.y, box.bottomRight.y);

      const centerX = (boxMinX + boxMaxX) / 2;
      const centerY = (boxMinY + boxMaxY) / 2;
      const centerXPercent = ((centerX - cropBounds.minX) / cropBounds.width) * 100;
      const centerYPercent = ((centerY - cropBounds.minY) / cropBounds.height) * 100;

      labels.push({ pieceIndex, centerXPercent, centerYPercent });
    });
    
    return labels;
  }, [boundingBoxes, cropBounds, pieceIndexMap]);

  const renderSolution = () => {
    const { positions, rotations } = puzzleInfoResponse.bestSolution;
    const solutionGrid: (number | null)[] = Array(9).fill(null);

    Object.entries(positions).forEach(([originalPieceIndexStr, positionIndex]) => {
      const originalPieceIndex = parseInt(originalPieceIndexStr);
      const posIndex = parseInt(positionIndex.toString());
      if (posIndex >= 0 && posIndex < 9) {
        solutionGrid[posIndex] = originalPieceIndex;
      }
    });

    const grid: (number | null)[][] = [];
    for (let row = 0; row < 3; row++) {
      grid[row] = [];
      for (let col = 0; col < 3; col++) {
        const index = row * 3 + col;
        grid[row][col] = solutionGrid[index];
      }
    }

    return (
      <div className="solution-grid">
        {grid.map((row, rowIndex) => (
          <div key={rowIndex} className="solution-row">
            {row.map((originalPieceIndex, colIndex) => {
              if (originalPieceIndex === null) {
                return <div key={colIndex} className="solution-cell empty" />;
              }

              let rotation = rotations[originalPieceIndex.toString()] || 0;
              if (rotation === 1) {
                rotation = 3;
              } else if (rotation === 3) {
                rotation = 1;
              }

              const hasValidPiece = pieces && 
                                    pieces.length > originalPieceIndex && 
                                    pieces[originalPieceIndex] && 
                                    typeof pieces[originalPieceIndex] === 'string' && 
                                    pieces[originalPieceIndex].trim().length > 0;
              
              let pieceImage: string;
              if (hasValidPiece) {
                pieceImage = pieces[originalPieceIndex];
              } else if (pieceTriangles[originalPieceIndex.toString()] && pieceTriangles[originalPieceIndex.toString()].length > 0) {
                const triangleIndex = pieceTriangles[originalPieceIndex.toString()][0];
                pieceImage = images[triangleIndex] || '';
              } else {
                pieceImage = images[originalPieceIndex * 4] || '';
              }

              const getRotationArrow = (rot: number): string => {
                switch (rot) {
                  case 1: return '↻';
                  case 2: return '↓';
                  case 3: return '↺';
                  default: return '';
                }
              };

              return (
                <div key={colIndex} className="solution-cell">
                  <div className="piece-container" style={{ transform: `rotate(${rotation * 90}deg)` }}>
                    <img src={pieceImage} alt={`Piece ${originalPieceIndex}`} className="solution-piece-image" />
                    {showLabels && (
                      <div className="piece-label-container" style={{ transform: `translate(-50%, -50%) rotate(${-rotation * 90}deg)` }}>
                        <div className="piece-label">{originalPieceIndex}</div>
                        {rotation > 0 && (
                          <div className="rotation-indicator">{getRotationArrow(rotation)}</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="solve-page">
      <div className="solve-content">
        <div className="original-pieces-section">
          <h2>Original Pieces</h2>
          {imageUrl && cropBounds && imageDimensions ? (
            <div className="original-image-container">
              <div 
                style={{ 
                  position: 'relative', 
                  width: '100%',
                  aspectRatio: `${cropBounds.width} / ${cropBounds.height}`,
                  overflow: 'hidden'
                }}
              >
                <img 
                  ref={imageRef}
                  src={imageUrl} 
                  alt="Original puzzle pieces" 
                  className="original-image"
                  style={{
                    position: 'absolute',
                    width: `${(imageDimensions.width / cropBounds.width) * 100}%`,
                    height: 'auto',
                    left: `${-(cropBounds.minX / cropBounds.width) * 100}%`,
                    top: `${-(cropBounds.minY / cropBounds.height) * 100}%`,
                    maxWidth: 'none'
                  }}
                />
                {showLabels && originalPieceLabels.map(({ pieceIndex, centerXPercent, centerYPercent }) => (
                  <div
                    key={pieceIndex}
                    className="piece-label-container"
                    style={{
                      position: 'absolute',
                      left: `${centerXPercent}%`,
                      top: `${centerYPercent}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  >
                    <div className="piece-label">{pieceIndex}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="loading-message">Loading image...</div>
          )}
        </div>

        <div className="solution-section">
          <h2>Solved Puzzle</h2>
          {renderSolution()}
        </div>
      </div>

      <div className="puzzle-info-section">
        <div className="puzzle-info-grid">
          <div className="puzzle-info-item">
            <span className="puzzle-info-label">Difficulty</span>
            <span className="puzzle-info-value">{puzzleInfoResponse.info.difficulty}</span>
          </div>
          <div className="puzzle-info-item">
            <span className="puzzle-info-label">Valid 2x2 Combinations</span>
            <span className="puzzle-info-value">{puzzleInfoResponse.info.numValidQuads}</span>
          </div>
          <div className="puzzle-info-item">
            <span className="puzzle-info-label">Solutions (with rotations)</span>
            <span className="puzzle-info-value">{puzzleInfoResponse.info.numSolutions}</span>
          </div>
          <div className="puzzle-info-item">
            <span className="puzzle-info-label">Unique Solutions</span>
            <span className="puzzle-info-value">{puzzleInfoResponse.info.numUniqueSolutions}</span>
          </div>
        </div>
      </div>

      <div className="solve-page-actions">
        <button onClick={onBack} className="button button-back">
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          Back
        </button>
        
        <button 
          className="button button-toggle"
          onClick={() => setShowLabels(!showLabels)}
        >
          <span className="toggle-icon">👁</span>
          Toggle Labels
        </button>
        
        <button onClick={onStartOver} className="button button-home">
          <img src="/puzzle-logo.svg" alt="" className="button-logo" />
          Home
        </button>
      </div>
    </div>
  );
}
