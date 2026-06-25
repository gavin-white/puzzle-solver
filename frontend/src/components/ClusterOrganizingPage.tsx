import { useState, useCallback, useMemo } from 'react';
import type { SubmittedData } from '../types';
import type { ShowToast } from '../types/ui';
import { type TriangleItem, getPieceIndexForTriangle, getTrianglePart } from '../utils/clusterUtils';
import { usePointerTransfer } from '../hooks/usePointerTransfer';
import { useNarrowLayout } from '../hooks/useNarrowLayout';
/* Organizing and matching steps share layout/action styles. */
import './ClusterMatchingPage.css';

interface ClusterOrganizingPageProps {
  submittedData: SubmittedData;
  initialClusters?: number[] | null;
  onEdit: () => void;
  onSubmit: (clusters: number[]) => void | Promise<void>;
  isSubmitting?: boolean;
  onShowToast?: ShowToast;
}

function buildInitialOrder(clustersData: number[]): Map<number, number[]> {
  const order = new Map<number, number[]>();
  clustersData.forEach((clusterId, index) => {
    if (!order.has(clusterId)) {
      order.set(clusterId, []);
    }
    order.get(clusterId)!.push(index);
  });
  return order;
}

/** Drag triangles between the eight similarity clusters before edge matching. */
export function ClusterOrganizingPage({ submittedData, initialClusters: propClusters, onEdit, onSubmit, isSubmitting = false, onShowToast }: ClusterOrganizingPageProps) {
  const { submitResponse } = submittedData;
  
  // Memoize images to avoid creating new array reference on every render
  const images = useMemo(() => submitResponse?.images || [], [submitResponse?.images]);
  const originalClusters = useMemo(() => submitResponse?.clusters || [], [submitResponse?.clusters]);
  // Use prop clusters if provided (for returning from matching page), otherwise use original
  const initialClusters = useMemo(
    () => propClusters && propClusters.length > 0 ? propClusters : originalClusters,
    [propClusters, originalClusters]
  );
  const pieceTriangles = useMemo(() => submitResponse?.pieceTriangles || {}, [submitResponse?.pieceTriangles]);

  const [clusters, setClusters] = useState<number[]>(
    initialClusters && initialClusters.length === images.length ? initialClusters : []
  );

  const [triangleOrder, setTriangleOrder] = useState<Map<number, number[]>>(() => {
    if (initialClusters && initialClusters.length === images.length) {
      return buildInitialOrder(initialClusters);
    }
    return new Map<number, number[]>();
  });

  const handleTransfer = useCallback(
    (triangleIndex: number, targetClusterId: number) => {
      const sourceClusterId = clusters[triangleIndex];
      if (sourceClusterId === targetClusterId) return;

      const newClusters = [...clusters];
      newClusters[triangleIndex] = targetClusterId;
      setClusters(newClusters);

      setTriangleOrder((prev) => {
        const newOrder = new Map(prev);

        if (newOrder.has(sourceClusterId)) {
          newOrder.set(
            sourceClusterId,
            newOrder.get(sourceClusterId)!.filter((idx) => idx !== triangleIndex)
          );
        }

        if (!newOrder.has(targetClusterId)) {
          newOrder.set(targetClusterId, []);
        }
        const targetOrder = newOrder.get(targetClusterId)!;
        const filteredOrder = targetOrder.filter((idx) => idx !== triangleIndex);
        filteredOrder.push(triangleIndex);
        newOrder.set(targetClusterId, filteredOrder);

        return newOrder;
      });
    },
    [clusters]
  );

  const narrow = useNarrowLayout();

  const {
    draggedItem: draggedTriangle,
    selectedItem: selectedTriangle,
    dragOverTarget: dragOverCluster,
    previewPosition,
    isDragging,
    handlePointerDown,
    handleSelectItem,
    handleTapTarget,
  } = usePointerTransfer<number, number>({
    onTransfer: handleTransfer,
    targetDataAttribute: 'drop-target',
    parseTarget: (value) => parseInt(value, 10),
    tapMode: narrow,
  });

  // Track the original cluster IDs so empty groups don't disappear
  const originalClusterIds = useMemo(() => {
    const ids = new Set<number>();
    originalClusters.forEach((clusterId) => ids.add(clusterId));
    return ids;
  }, [originalClusters]);

  const clusterGroups = useMemo(() => {
    const groups = new Map<number, TriangleItem[]>();

    // Include both original cluster IDs and any current ones
    const allClusterIds = new Set<number>(originalClusterIds);
    clusters.forEach((clusterId) => {
      allClusterIds.add(clusterId);
    });

    allClusterIds.forEach((clusterId) => {
      groups.set(clusterId, []);
    });

    const orderMap = triangleOrder;
    allClusterIds.forEach((clusterId) => {
      const orderedIndices = orderMap.get(clusterId) || [];
      const clusterIndices = clusters
        .map((cId, idx) => (cId === clusterId ? idx : -1))
        .filter((idx) => idx !== -1);

      // Use Set to track already-added indices and prevent duplicates
      const addedIndices = new Set<number>();
      const sortedIndices: number[] = [];
      for (const idx of orderedIndices) {
        if (clusterIndices.includes(idx) && !addedIndices.has(idx)) {
          sortedIndices.push(idx);
          addedIndices.add(idx);
        }
      }
      const remainingIndices = clusterIndices.filter((idx) => !addedIndices.has(idx));
      const finalOrder = [...sortedIndices, ...remainingIndices];

      finalOrder.forEach((triangleIndex) => {
        const pieceIndex = getPieceIndexForTriangle(pieceTriangles, triangleIndex);
        const trianglePart = getTrianglePart(pieceTriangles, triangleIndex);
        groups.get(clusterId)!.push({
          index: triangleIndex,
          dataUri: images[triangleIndex],
          pieceIndex: pieceIndex ?? Math.floor(triangleIndex / 4),
          trianglePart,
        });
      });
    });

    return groups;
  }, [clusters, images, triangleOrder, originalClusterIds, pieceTriangles]);

  const clusterIds = useMemo(() => {
    return Array.from(clusterGroups.keys()).sort((a, b) => a - b);
  }, [clusterGroups]);

  const hasEmptyClusters = useMemo(() => {
    return clusterIds.some((clusterId) => {
      const triangles = clusterGroups.get(clusterId) || [];
      return triangles.length === 0;
    });
  }, [clusterIds, clusterGroups]);

  const handleSubmit = useCallback(() => {
    if (hasEmptyClusters) {
      onShowToast?.('Each group must have at least one image to proceed', 'error');
      return;
    }
    void onSubmit(clusters);
  }, [clusters, hasEmptyClusters, onSubmit, onShowToast]);

  const draggedTriangleData = draggedTriangle !== null
    ? clusterGroups.get(clusters[draggedTriangle])?.find((t) => t.index === draggedTriangle)
    : null;

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

  if (!initialClusters || initialClusters.length !== images.length) {
    return (
      <div className="cluster-matching-page">
        <div className="error-message">
          <h2>Invalid cluster data</h2>
          <p>Expected {images.length} cluster assignments, but got {initialClusters?.length || 0}.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="cluster-matching-page">
      <p className="flow-step-instruction">
        <span className="matching-instruction matching-instruction--wide">
          Drag images between groups so each group contains only matching edge patterns.
        </span>
        <span className="matching-instruction matching-instruction--narrow">
          Tap an image to select it, then tap a group to move it there.
        </span>
      </p>
      <div className="clusters-container">
        {clusterIds.map((clusterId) => {
          const triangles = clusterGroups.get(clusterId) || [];
          const isDragOver = dragOverCluster === clusterId;
          const isDropReady = narrow && selectedTriangle !== null;

          return (
            <div
              key={clusterId}
              className={`cluster-group ${isDragOver ? 'drag-over' : ''} ${isDropReady ? 'transfer-drop-ready' : ''}`}
              data-drop-target={clusterId}
              onClick={() => {
                if (narrow && selectedTriangle !== null) {
                  handleTapTarget(clusterId);
                }
              }}
            >
              <div className="cluster-meta">
                <span className="cluster-count">{triangles.length} images</span>
              </div>
              <div className="cluster-triangles">
                {triangles.length > 0 ? (
                  triangles.map((triangle) => (
                    <div
                      key={triangle.index}
                      className={`triangle-item ${draggedTriangle === triangle.index ? 'dragging' : ''} ${selectedTriangle === triangle.index ? 'transfer-selected' : ''}`}
                      onPointerDown={
                        narrow
                          ? undefined
                          : (e) => handlePointerDown(e, triangle.index, e.currentTarget as HTMLElement)
                      }
                      onClick={
                        narrow
                          ? (e) => {
                              e.stopPropagation();
                              if (selectedTriangle !== null) {
                                if (selectedTriangle === triangle.index) {
                                  handleSelectItem(triangle.index);
                                } else {
                                  handleTapTarget(clusterId);
                                }
                              } else {
                                handleSelectItem(triangle.index);
                              }
                            }
                          : undefined
                      }
                      style={narrow ? undefined : { touchAction: 'none' }}
                    >
                      <img
                        src={triangle.dataUri}
                        alt={`Piece ${triangle.pieceIndex + 1} - ${triangle.trianglePart}`}
                        className="triangle-image"
                        draggable={false}
                      />
                    </div>
                  ))
                ) : (
                  <div className="cluster-empty-placeholder">
                    Empty - drag images here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!narrow && isDragging && previewPosition && draggedTriangleData && (
        <div
          className="pointer-drag-preview"
          style={{
            left: previewPosition.left,
            top: previewPosition.top,
          }}
        >
          <img
            src={draggedTriangleData.dataUri}
            alt=""
            className="triangle-image"
            draggable={false}
          />
        </div>
      )}

      <div className="cluster-matching-page-actions">
        <button onClick={onEdit} className="button button-edit">
          ← Edit
        </button>
        <button
          onClick={handleSubmit}
          disabled={isSubmitting}
          className={`button button-submit ${hasEmptyClusters ? 'button-submit-disabled' : ''}`}
          title={hasEmptyClusters ? 'Each group must have at least one image to proceed' : undefined}
        >
          <svg className="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          {isSubmitting ? 'Matching...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
