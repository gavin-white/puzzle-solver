/**
 * Central state and handlers for the upload → crop → boxes → clusters → solve flow,
 * plus standalone “play” mode. Keeps `currentPage` in sync with required data.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { ApiService } from '../services/api';
import type { PageType, BoundingBox, BoundingBoxHistory, SubmittedData, PuzzleInfoResponse } from '../types';
import type { ShowToast } from '../types/ui';
import { userMessageFromError } from '../utils/errors';

/** Puzzle flow state machine + API-backed transitions (pass `showToast` for errors). */
export function usePuzzleState(showToast: ShowToast) {
  // Current page
  const [currentPage, setCurrentPage] = useState<PageType>('home');

  // Upload state (crop page creates its own object URL from the file)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  // Crop state
  const [croppedFile, setCroppedFile] = useState<File | null>(null);
  const [croppedImageUrl, setCroppedImageUrl] = useState<string | null>(null);

  // Bounding box state
  const [boundingBoxes, setBoundingBoxes] = useState<BoundingBox[]>([]);
  const [boundingBoxHistory, setBoundingBoxHistory] = useState<BoundingBoxHistory[]>([]);

  // Submit / cluster state
  const [submittedData, setSubmittedData] = useState<SubmittedData | null>(null);
  const [modifiedClusters, setModifiedClusters] = useState<number[] | null>(null);
  const [modifiedMatchingOrder, setModifiedMatchingOrder] = useState<number[] | null>(null);

  // Solution state
  const [puzzleInfoResponse, setPuzzleInfoResponse] = useState<PuzzleInfoResponse | null>(null);

  // Play state
  const [playPuzzleId, setPlayPuzzleId] = useState<string | null>(null);
  const [playPuzzleName, setPlayPuzzleName] = useState<string | null>(null);

  // Loading
  const [isLoading, setIsLoading] = useState(false);

  // Derived state
  const pieceIndexMap = useMemo(() => {
    if (boundingBoxes.length === 0) return new Map<number, number>();

    const pieceBoxes = boundingBoxes.map((box, index) => {
      const centerY = (box.topLeft.y + box.topRight.y + box.bottomLeft.y + box.bottomRight.y) / 4;
      const centerX = (box.topLeft.x + box.topRight.x + box.bottomLeft.x + box.bottomRight.x) / 4;
      return { boundingBoxIndex: index, centerY, centerX };
    });

    const sortedByY = [...pieceBoxes].sort((a, b) => a.centerY - b.centerY);
    const row1 = sortedByY.slice(0, 3).sort((a, b) => a.centerX - b.centerX);
    const row2 = sortedByY.slice(3, 6).sort((a, b) => a.centerX - b.centerX);
    const row3 = sortedByY.slice(6, 9).sort((a, b) => a.centerX - b.centerX);

    const sortedPieces = [...row1, ...row2, ...row3];
    const indexMap = new Map<number, number>();
    sortedPieces.forEach((piece, pieceIndex) => {
      indexMap.set(pieceIndex, piece.boundingBoxIndex);
    });

    return indexMap;
  }, [boundingBoxes]);

  const canUndo = boundingBoxHistory.length > 1;
  const canSubmit = boundingBoxes.length > 0;

  // Redirect to a valid page if required state is missing
  useEffect(() => {
    if (currentPage === 'crop' && !uploadedFile) {
      setCurrentPage('home');
    } else if (currentPage === 'boundingBox' && !croppedImageUrl) {
      setCurrentPage('home');
    } else if (currentPage === 'clusterOrganizing' && !submittedData) {
      setCurrentPage('home');
    } else if (currentPage === 'clusterMatching' && (!submittedData || !modifiedClusters || !modifiedMatchingOrder)) {
      setCurrentPage('clusterOrganizing');
    } else if (currentPage === 'solve' && (!submittedData || !puzzleInfoResponse)) {
      setCurrentPage('clusterOrganizing');
    }
  }, [currentPage, uploadedFile, croppedImageUrl, submittedData, modifiedClusters, modifiedMatchingOrder, puzzleInfoResponse]);


  const handleImageSelect = useCallback((file: File) => {
    setUploadedFile(file);
    setCurrentPage('crop');
  }, []);

  const handleBuiltInImageSelect = useCallback(async (imageUrl: string, imageName: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error('Failed to load built-in image');
      }
      const blob = await response.blob();
      const file = new File([blob], `${imageName}.jpg`, { type: 'image/jpeg' });

      setUploadedFile(file);
      setCurrentPage('crop');
    } catch (error) {
      showToast(
        userMessageFromError(error, 'Unable to load this puzzle image right now. Please try again.'),
        'error'
      );
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  const handlePlayClick = useCallback((puzzleId: string, puzzleName: string) => {
    setPlayPuzzleId(puzzleId);
    setPlayPuzzleName(puzzleName);
    setCurrentPage('play');
  }, []);

  const handleBackFromPlay = useCallback(() => {
    setCurrentPage('home');
  }, []);

  const handleCropCancel = useCallback(() => {
    setUploadedFile(null);
    setCurrentPage('home');
  }, []);

  const handleCropApply = useCallback(async (croppedFileResult: File) => {
    setIsLoading(true);

    try {
      const imageUrl = URL.createObjectURL(croppedFileResult);
      const detectedBoxes = await ApiService.detectBoundingBoxes(croppedFileResult);

      const boxesWithIds = detectedBoxes.map((box, index) => ({
        ...box,
        id: box.id || `box-${index}-${Date.now()}`,
      }));

      setCroppedFile(croppedFileResult);
      setCroppedImageUrl(imageUrl);
      setBoundingBoxes(boxesWithIds);
      setBoundingBoxHistory([{ boundingBoxes: boxesWithIds, timestamp: Date.now() }]);

      setUploadedFile(null);
      setCurrentPage('boundingBox');
    } catch (error) {
      showToast(
        userMessageFromError(error, 'Unable to process this image right now. Please try again.'),
        'error'
      );
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  const handleBackToUpload = useCallback(() => {
    if (croppedImageUrl) {
      URL.revokeObjectURL(croppedImageUrl);
    }
    if (submittedData?.imageUrl) {
      URL.revokeObjectURL(submittedData.imageUrl);
    }

    setCroppedFile(null);
    setCroppedImageUrl(null);
    setBoundingBoxes([]);
    setBoundingBoxHistory([]);
    setSubmittedData(null);
    setModifiedClusters(null);
    setModifiedMatchingOrder(null);
    setPuzzleInfoResponse(null);
    setCurrentPage('home');
  }, [croppedImageUrl, submittedData]);

  const handleBoundingBoxesChange = useCallback((boxes: BoundingBox[], addToHistory: boolean = true) => {
    setBoundingBoxes(boxes);
    if (addToHistory) {
      setBoundingBoxHistory(prev => [...prev, { boundingBoxes: boxes, timestamp: Date.now() }]);
    }
  }, []);

  const handleBackToCrop = useCallback(() => {
    setCurrentPage('crop');
  }, []);

  const handleReset = useCallback(() => {
    if (boundingBoxHistory.length === 0) return;
    const originalBoxes = boundingBoxHistory[0].boundingBoxes;
    setBoundingBoxes(originalBoxes);
    setBoundingBoxHistory([boundingBoxHistory[0]]);
  }, [boundingBoxHistory]);

  const handleUndo = useCallback(() => {
    if (boundingBoxHistory.length <= 1) return;
    const newHistory = [...boundingBoxHistory];
    newHistory.pop();
    const previousBoxes = newHistory[newHistory.length - 1].boundingBoxes;
    setBoundingBoxes(previousBoxes);
    setBoundingBoxHistory(newHistory);
  }, [boundingBoxHistory]);

  const handleSubmitBoundingBoxes = useCallback(async () => {
    if (!croppedFile || boundingBoxes.length === 0) return;

    setIsLoading(true);

    try {
      const indexedBoundingBoxes: Record<string, BoundingBox> = {};
      pieceIndexMap.forEach((boundingBoxIndex, pieceIndex) => {
        indexedBoundingBoxes[pieceIndex.toString()] = boundingBoxes[boundingBoxIndex];
      });

      const response = await ApiService.submitBoundingBoxes(croppedFile, indexedBoundingBoxes);

      setSubmittedData({
        imageFile: croppedFile,
        imageUrl: croppedImageUrl!,
        boundingBoxes,
        pieceIndexMap,
        submitResponse: response,
        timestamp: Date.now(),
      });

      setModifiedClusters(null);
      setModifiedMatchingOrder(null);

      setCurrentPage('clusterOrganizing');
    } catch (error) {
      showToast(
        userMessageFromError(error, 'Unable to submit puzzle pieces right now. Please try again.'),
        'error'
      );
    } finally {
      setIsLoading(false);
    }
  }, [croppedFile, croppedImageUrl, boundingBoxes, pieceIndexMap, showToast]);

  const handleEditBoundingBoxes = useCallback(() => {
    setCurrentPage('boundingBox');
  }, []);

  const handleOrganizingSubmit = useCallback(async (clusters: number[]) => {
    if (!submittedData) return;

    setIsLoading(true);
    const images = submittedData.submitResponse.images;
    const sortedClusterIds = Array.from(new Set(clusters)).sort((a, b) => a - b);
    let matchingOrder = sortedClusterIds;

    try {
      const repImages: string[] = [];
      const repIds: number[] = [];
      for (const clusterId of sortedClusterIds) {
        const index = clusters.indexOf(clusterId);
        if (index >= 0 && images[index]) {
          repImages.push(images[index]);
          repIds.push(clusterId);
        }
      }

      if (repImages.length >= 2 && repImages.length % 2 === 0) {
        const result = await ApiService.matchTriangles(repImages, repIds);
        matchingOrder = result.matchingOrder;
      }
    } catch {
      showToast('Could not auto-match clusters. Please arrange them manually.', 'info');
    } finally {
      setModifiedClusters(clusters);
      setModifiedMatchingOrder(matchingOrder);
      setCurrentPage('clusterMatching');
      setIsLoading(false);
    }
  }, [submittedData, showToast]);

  const handleBackToOrganizing = useCallback(() => {
    setCurrentPage('clusterOrganizing');
  }, []);

  const handleSolve = useCallback((newClusters: number[], newMatchingOrder: number[], response: PuzzleInfoResponse) => {
    setModifiedClusters(newClusters);
    setModifiedMatchingOrder(newMatchingOrder);
    setPuzzleInfoResponse(response);
    setCurrentPage('solve');
  }, []);

  const handleBackToClusterMatching = useCallback(() => {
    setCurrentPage('clusterMatching');
  }, []);

  const handleStartOver = useCallback(() => {
    handleBackToUpload();
  }, [handleBackToUpload]);

  return {
    // Navigation
    currentPage,

    // Upload state
    uploadedFile,

    // Crop state
    croppedImageUrl,

    // Bounding box state
    boundingBoxes,
    canUndo,
    canSubmit,

    // Submit state
    submittedData,

    // Cluster state
    modifiedClusters,
    modifiedMatchingOrder,

    // Solution state
    puzzleInfoResponse,

    // Play state
    playPuzzleId,
    playPuzzleName,

    // Loading
    isLoading,

    // Handlers
    handleImageSelect,
    handleBuiltInImageSelect,
    handlePlayClick,
    handleBackFromPlay,
    handleCropCancel,
    handleCropApply,
    handleBackToUpload,
    handleBoundingBoxesChange,
    handleBackToCrop,
    handleReset,
    handleUndo,
    handleSubmitBoundingBoxes,
    handleEditBoundingBoxes,
    handleOrganizingSubmit,
    handleBackToOrganizing,
    handleSolve,
    handleBackToClusterMatching,
    handleStartOver,
  };
}
