import React, { useState, useCallback, useMemo, useEffect } from 'react';
import type { SubmittedData, SolveRequest, PuzzleInfoResponse } from '../types';
import type { ShowToast } from '../types/ui';
import { ApiService } from '../services/api';
import { type TriangleItem, getPieceIndexForTriangle, getTrianglePart } from '../utils/clusterUtils';
import { userMessageFromError } from '../utils/errors';
import { usePointerTransfer } from '../hooks/usePointerTransfer';
import './ClusterMatchingPage.css';

interface ClusterMatchingPageProps {
  submittedData: SubmittedData;
  clusters: number[];
  initialMatchingOrder?: number[] | null;
  onBack: () => void;
  onSolve: (clusters: number[], matchingOrder: number[], puzzleInfoResponse: PuzzleInfoResponse) => void;
  onShowToast?: ShowToast;
}

type DraggedCluster = {
  clusterId: number;
  isBottom: boolean;
  imageSrc: string;
};

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

  const handleTransfer = useCallback((dragged: DraggedCluster, targetPosition: number) => {
    setMatchingOrder((prev) => {
      const newOrder = [...prev];
      const currentIndex = newOrder.indexOf(dragged.clusterId);
      const targetIndex = targetPosition;

      if (currentIndex !== targetIndex && currentIndex !== -1) {
        const targetClusterId = newOrder[targetIndex];
        newOrder[targetIndex] = dragged.clusterId;
        newOrder[currentIndex] = targetClusterId;
      }

      return newOrder;
    });
  }, []);

  const getTargetFromPoint = useCallback((clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const dropZone = element?.closest('[data-drop-target]');
    if (!dropZone) return null;
    const value = dropZone.getAttribute('data-drop-target');
    if (value === null) return null;
    const position = parseInt(value, 10);
    return Number.isNaN(position) ? null : position;
  }, []);

  const {
    draggedItem: draggedCluster,
    dragOverTarget: dragOverPosition,
    previewPosition,
    isDragging,
    handlePointerDown,
  } = usePointerTransfer<DraggedCluster, number>({
    onTransfer: handleTransfer,
    getTargetFromPoint,
  });

  const [dragPreviewLayout, setDragPreviewLayout] = useState<{
    width: number;
    height: number;
    narrow: boolean;
  } | null>(null);

  useEffect(() => {
    if (!isDragging) {
      setDragPreviewLayout(null);
    }
  }, [isDragging]);

  const handleClusterPointerDown = useCallback((
    e: React.PointerEvent,
    clusterId: number,
    isBottom: boolean,
    imageSrc: string
  ) => {
    const img = (e.currentTarget as HTMLElement).querySelector('.matching-triangle-image');
    const rect = img?.getBoundingClientRect();
    if (rect) {
      setDragPreviewLayout({
        width: rect.width,
        height: rect.height,
        narrow: window.matchMedia('(max-width: 768px)').matches,
      });
    }
    handlePointerDown(e, { clusterId, isBottom, imageSrc }, e.currentTarget as HTMLElement);
  }, [handlePointerDown]);

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

  const dragClusterPreview = draggedCluster ? (
    <div className={`matching-cluster ${draggedCluster.isBottom ? 'bottom-cluster' : 'top-cluster'}`}>
      <div className="matching-triangle-frame">
        <img
          src={draggedCluster.imageSrc}
          alt=""
          className="matching-triangle-image"
          draggable={false}
        />
      </div>
    </div>
  ) : null;

  return (
    <div className="cluster-matching-page matching-mode">
      <p className="flow-step-instruction">
        <span className="matching-instruction matching-instruction--wide">
          Reorder columns so the top and bottom images in each column are a matching pair.
        </span>
        <span className="matching-instruction matching-instruction--narrow">
          Reorder rows so the left and right images in each row are a matching pair.
        </span>
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
                      className={`matching-cluster top-cluster ${dragOverPosition === colIndex ? 'drag-over' : ''} ${draggedCluster?.clusterId === topClusterId ? 'dragging' : ''}`}
                      data-drop-target={colIndex}
                      onPointerDown={(e) => {
                        if (topRepresentative) {
                          handleClusterPointerDown(e, topClusterId, false, topRepresentative.dataUri);
                        }
                      }}
                      style={{ touchAction: 'none' }}
                    >
                      {topRepresentative ? (
                        <div className="matching-triangle-frame">
                          <img
                            src={topRepresentative.dataUri}
                            alt={`Cluster ${topClusterId}`}
                            className="matching-triangle-image"
                          />
                        </div>
                      ) : (
                        <div className="matching-empty">Empty</div>
                      )}
                    </div>
                  )}

                  {bottomClusterId !== undefined && (
                    <div
                      className={`matching-cluster bottom-cluster ${dragOverPosition === colIndex + cols ? 'drag-over' : ''} ${draggedCluster?.clusterId === bottomClusterId ? 'dragging' : ''}`}
                      data-drop-target={colIndex + cols}
                      onPointerDown={(e) => {
                        if (bottomRepresentative) {
                          handleClusterPointerDown(e, bottomClusterId, true, bottomRepresentative.dataUri);
                        }
                      }}
                      style={{ touchAction: 'none' }}
                    >
                      {bottomRepresentative ? (
                        <div className="matching-triangle-frame">
                          <img
                            src={bottomRepresentative.dataUri}
                            alt={`Cluster ${bottomClusterId}`}
                            className="matching-triangle-image"
                          />
                        </div>
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

      {isDragging && previewPosition && draggedCluster && (
        <div
          className="pointer-drag-preview pointer-drag-preview--matching"
          style={{
            left: previewPosition.left,
            top: previewPosition.top,
            ...(dragPreviewLayout
              ? {
                  width: dragPreviewLayout.width,
                  height: dragPreviewLayout.height,
                  maxWidth: 'none',
                }
              : {}),
          }}
        >
          {dragPreviewLayout?.narrow ? (
            <div
              className="matching-column-panel matching-column-panel--drag-preview"
              style={{ width: dragPreviewLayout.height }}
            >
              {dragClusterPreview}
            </div>
          ) : (
            dragClusterPreview
          )}
        </div>
      )}

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
