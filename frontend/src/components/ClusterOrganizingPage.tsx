import React, { useState, useCallback, useMemo } from 'react';
import type { SubmittedData } from '../types';
import type { ShowToast } from '../types/ui';
import { type TriangleItem, getPieceIndexForTriangle, getTrianglePart } from '../utils/clusterUtils';
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
  const [draggedTriangle, setDraggedTriangle] = useState<number | null>(null);
  const [dragOverCluster, setDragOverCluster] = useState<number | null>(null);

  const [triangleOrder, setTriangleOrder] = useState<Map<number, number[]>>(() => {
    if (initialClusters && initialClusters.length === images.length) {
      return buildInitialOrder(initialClusters);
    }
    return new Map<number, number[]>();
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

  // Grouping mode handlers
  const handleDragStart = useCallback((e: React.DragEvent, triangleIndex: number) => {
    setDraggedTriangle(triangleIndex);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', triangleIndex.toString());
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedTriangle(null);
    setDragOverCluster(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, clusterId: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverCluster(clusterId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverCluster(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetClusterId: number) => {
      e.preventDefault();
      if (draggedTriangle === null) return;

      const sourceClusterId = clusters[draggedTriangle];
      if (sourceClusterId !== targetClusterId) {
        const newClusters = [...clusters];
        newClusters[draggedTriangle] = targetClusterId;
        setClusters(newClusters);

        setTriangleOrder((prev) => {
          const newOrder = new Map(prev);
          
          // Remove from source cluster
          if (newOrder.has(sourceClusterId)) {
            newOrder.set(
              sourceClusterId,
              newOrder.get(sourceClusterId)!.filter((idx) => idx !== draggedTriangle)
            );
          }
          
          // Add to target cluster (but avoid duplicates)
          if (!newOrder.has(targetClusterId)) {
            newOrder.set(targetClusterId, []);
          }
          const targetOrder = newOrder.get(targetClusterId)!;
          // First remove any existing entry to avoid duplicates
          const filteredOrder = targetOrder.filter((idx) => idx !== draggedTriangle);
          filteredOrder.push(draggedTriangle);
          newOrder.set(targetClusterId, filteredOrder);
          
          return newOrder;
        });
      }

      setDraggedTriangle(null);
      setDragOverCluster(null);
    },
    [draggedTriangle, clusters]
  );

  const handleSubmit = useCallback(() => {
    if (hasEmptyClusters) {
      onShowToast?.('Each group must have at least one image to proceed', 'error');
      return;
    }
    void onSubmit(clusters);
  }, [clusters, hasEmptyClusters, onSubmit, onShowToast]);

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
        Drag images between groups so each group contains only matching edge patterns.
      </p>
      <div className="clusters-container">
        {clusterIds.map((clusterId) => {
          const triangles = clusterGroups.get(clusterId) || [];
          const isDragOver = dragOverCluster === clusterId;

          return (
            <div
              key={clusterId}
              className={`cluster-group ${isDragOver ? 'drag-over' : ''}`}
              onDragOver={(e) => handleDragOver(e, clusterId)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, clusterId)}
            >
              <div className="cluster-meta">
                <span className="cluster-count">{triangles.length} images</span>
              </div>
              <div className="cluster-triangles">
                {triangles.length > 0 ? (
                  triangles.map((triangle) => (
                    <div
                      key={triangle.index}
                      className={`triangle-item ${draggedTriangle === triangle.index ? 'dragging' : ''}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, triangle.index)}
                      onDragEnd={handleDragEnd}
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
                  <div style={{ 
                    gridColumn: '1 / -1', 
                    textAlign: 'center', 
                    color: 'var(--color-text-muted)', 
                    padding: '2rem',
                    fontStyle: 'italic',
                    fontSize: '0.85rem'
                  }}>
                    Empty - drag images here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

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
