import React, { useState, useCallback, useMemo } from 'react';
import type { SubmittedData, SolveRequest, PuzzleInfoResponse } from '../types';
import type { ShowToast } from '../types/ui';
import { ApiService } from '../services/api';
import { type TriangleItem, getPieceIndexForTriangle, getTrianglePart } from '../utils/clusterUtils';
import { userMessageFromError } from '../utils/errors';
import './ClusterMatchingPage.css';

interface ClusterMatchingPageProps {
  submittedData: SubmittedData;
  clusters: number[];
  initialMatchingOrder?: number[] | null;
  onBack: () => void;
  onSolve: (clusters: number[], matchingOrder: number[], puzzleInfoResponse: PuzzleInfoResponse) => void;
  onShowToast?: ShowToast;
}

/** Pair cluster columns, then fetch puzzle info for solve. */
export function ClusterMatchingPage({ submittedData, clusters, initialMatchingOrder: propMatchingOrder, onBack, onSolve, onShowToast }: ClusterMatchingPageProps) {
  const { submitResponse } = submittedData;
  
  const images = useMemo(() => submitResponse?.images || [], [submitResponse?.images]);
  const pieceTriangles = useMemo(() => submitResponse?.pieceTriangles || {}, [submitResponse?.pieceTriangles]);

  const [isSolving, setIsSolving] = useState(false);
  const [matchingOrder, setMatchingOrder] = useState<number[]>(() => {
    if (propMatchingOrder && propMatchingOrder.length > 0) {
      return propMatchingOrder;
    }
    return [];
  });
  const [draggedClusterId, setDraggedClusterId] = useState<number | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<number | null>(null);

  const clusterGroups = useMemo(() => {
    const groups = new Map<number, TriangleItem[]>();

    const allClusterIds = new Set<number>();
    clusters.forEach((clusterId) => {
      allClusterIds.add(clusterId);
    });

    allClusterIds.forEach((clusterId) => {
      groups.set(clusterId, []);
    });

    clusters.forEach((clusterId, triangleIndex) => {
      const pieceIndex = getPieceIndexForTriangle(pieceTriangles, triangleIndex);
      const trianglePart = getTrianglePart(pieceTriangles, triangleIndex);
      groups.get(clusterId)!.push({
        index: triangleIndex,
        dataUri: images[triangleIndex],
        pieceIndex: pieceIndex ?? Math.floor(triangleIndex / 4),
        trianglePart,
      });
    });

    return groups;
  }, [clusters, images, pieceTriangles]);

  // Matching mode handlers — canvas preview matches on-screen size + rotation (native setDragImage uses full resolution and ignores CSS transform)
  const handleClusterDragStart = useCallback((e: React.DragEvent, clusterId: number) => {
    setDraggedClusterId(clusterId);
    e.dataTransfer.effectAllowed = 'move';
    const root = e.currentTarget as HTMLElement;
    const img = root.querySelector('img.matching-triangle-image');
    if (!(img instanceof HTMLImageElement) || !img.complete || img.naturalWidth <= 0) return;

    const rect = img.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rotate180 = root.classList.contains('bottom-cluster');
    if (rotate180) {
      ctx.translate(w / 2, h / 2);
      ctx.rotate(Math.PI);
      ctx.translate(-w / 2, -h / 2);
    }
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, w, h);

    e.dataTransfer.setDragImage(canvas, Math.round(w / 2), Math.round(h / 2));
  }, []);

  const handleClusterDragEnd = useCallback(() => {
    setDraggedClusterId(null);
    setDragOverPosition(null);
  }, []);

  const handleClusterDragOver = useCallback((e: React.DragEvent, position: number) => {
    if (draggedClusterId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverPosition(position);
  }, [draggedClusterId]);

  const handleClusterDrop = useCallback((e: React.DragEvent, targetPosition: number) => {
    if (draggedClusterId === null) return;
    e.preventDefault();

    const newOrder = [...matchingOrder];
    const currentIndex = newOrder.indexOf(draggedClusterId);
    const targetIndex = targetPosition;

    if (currentIndex !== targetIndex && currentIndex !== -1) {
      const targetClusterId = newOrder[targetIndex];
      newOrder[targetIndex] = draggedClusterId;
      newOrder[currentIndex] = targetClusterId;
      setMatchingOrder(newOrder);
    }

    setDraggedClusterId(null);
    setDragOverPosition(null);
  }, [draggedClusterId, matchingOrder]);

  const solveRequest = useMemo((): SolveRequest | null => {
    if (clusters.length !== 36 || images.length !== 36) return null;
    if (Object.keys(pieceTriangles).length === 0) return null;

    const pieces: Record<string, number[]> = {};

    for (let pieceIndex = 0; pieceIndex < 9; pieceIndex++) {
      const triangleIndices = pieceTriangles[pieceIndex.toString()];
      if (!triangleIndices || triangleIndices.length !== 4) continue;

      const [topIndex, bottomIndex, leftIndex, rightIndex] = triangleIndices;

      // Get the cluster ID for each triangle position
      pieces[pieceIndex.toString()] = [
        clusters[topIndex],
        clusters[rightIndex],
        clusters[bottomIndex],
        clusters[leftIndex],
      ];
    }

    // Build matches by pairing top/bottom clusters in the matching order
    const matches: Record<string, number> = {};
    const cols = 4;
    for (let col = 0; col < cols; col++) {
      const topClusterId = matchingOrder[col];
      const bottomClusterId = matchingOrder[col + cols];
      if (topClusterId !== undefined && bottomClusterId !== undefined) {
        matches[topClusterId.toString()] = bottomClusterId;
        matches[bottomClusterId.toString()] = topClusterId;
      }
    }

    return { pieces, matches };
  }, [clusters, images.length, pieceTriangles, matchingOrder]);

  const handleSolve = useCallback(async () => {
    if (!solveRequest) {
      onShowToast?.('Cannot solve: invalid puzzle configuration', 'error');
      return;
    }

    setIsSolving(true);
    try {
      const response = await ApiService.getPuzzleInfo(solveRequest);
      onSolve(clusters, matchingOrder, response);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      const noSolution = /unable to find solution|no solution/i.test(rawMessage);
      onShowToast?.(
        noSolution
          ? 'Unable to find a solution for this puzzle.'
          : userMessageFromError(error, 'Unable to solve this puzzle right now. Please try again.'),
        'error'
      );
    } finally {
      setIsSolving(false);
    }
  }, [solveRequest, clusters, matchingOrder, onSolve, onShowToast]);

  if (!images || images.length === 0) {
    return (
      <div className="cluster-matching-page">
        <div className="error-message">
          <h2>No images received</h2>
          <p>The API response did not include any images.</p>
        </div>
      </div>
    );
  }

  const cols = 4;

  return (
    <div className="cluster-matching-page matching-mode">
      <p className="flow-step-instruction">
        Reorder columns so the top and bottom images in each column are a matching pair.
      </p>
      <div className="matching-board">
        <div className="matching-container">
          {Array.from({ length: cols }).map((_, colIndex) => {
            const topClusterId = matchingOrder[colIndex];
            const bottomClusterId = matchingOrder[colIndex + cols];
            const topTriangles = topClusterId !== undefined ? clusterGroups.get(topClusterId) || [] : [];
            const bottomTriangles = bottomClusterId !== undefined ? clusterGroups.get(bottomClusterId) || [] : [];
            const topRepresentative = topTriangles[0];
            const bottomRepresentative = bottomTriangles[0];

            return (
              <div key={colIndex} className="matching-column">
                <div className="matching-column-panel">
                  {topClusterId !== undefined && (
                    <div
                      className={`matching-cluster top-cluster ${dragOverPosition === colIndex ? 'drag-over' : ''} ${draggedClusterId === topClusterId ? 'dragging' : ''}`}
                      draggable
                      onDragStart={(e) => handleClusterDragStart(e, topClusterId)}
                      onDragEnd={handleClusterDragEnd}
                      onDragOver={(e) => handleClusterDragOver(e, colIndex)}
                      onDrop={(e) => handleClusterDrop(e, colIndex)}
                    >
                      {topRepresentative ? (
                        <img
                          src={topRepresentative.dataUri}
                          alt={`Cluster ${topClusterId}`}
                          className="matching-triangle-image"
                        />
                      ) : (
                        <div className="matching-empty">Empty</div>
                      )}
                    </div>
                  )}

                  {bottomClusterId !== undefined && (
                    <div
                      className={`matching-cluster bottom-cluster ${dragOverPosition === colIndex + cols ? 'drag-over' : ''} ${draggedClusterId === bottomClusterId ? 'dragging' : ''}`}
                      draggable
                      onDragStart={(e) => handleClusterDragStart(e, bottomClusterId)}
                      onDragEnd={handleClusterDragEnd}
                      onDragOver={(e) => handleClusterDragOver(e, colIndex + cols)}
                      onDrop={(e) => handleClusterDrop(e, colIndex + cols)}
                    >
                      {bottomRepresentative ? (
                        <img
                          src={bottomRepresentative.dataUri}
                          alt={`Cluster ${bottomClusterId}`}
                          className="matching-triangle-image"
                          style={{ transform: 'rotate(180deg)' }}
                        />
                      ) : (
                        <div className="matching-empty">Empty</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="cluster-matching-page-actions">
        <button onClick={onBack} className="button button-edit">
          ← Modify Clusters
        </button>
        <button
          onClick={handleSolve}
          disabled={isSolving}
          className={`button button-solve ${!solveRequest && !isSolving ? 'button-disabled-visual' : ''}`}
          title={!solveRequest && !isSolving ? 'Cannot solve: invalid puzzle configuration' : undefined}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          {isSolving ? 'Solving...' : 'Solve'}
        </button>
      </div>
    </div>
  );
}
