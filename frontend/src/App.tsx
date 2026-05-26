/**
 * Root layout: routes between flow pages (landing → crop → … → solve/play),
 * global header, help modal, and toast host.
 */
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LandingPage } from './components/landing';
import { CropPage } from './components/CropPage';
import { BoundingBoxPage } from './components/BoundingBoxPage';
import { ClusterOrganizingPage } from './components/ClusterOrganizingPage';
import { ClusterMatchingPage } from './components/ClusterMatchingPage';
import { SolvePage } from './components/SolvePage';
import { PlayPage } from './components/PlayPage';
import { Toast } from './components/Toast';
import { useToast } from './hooks/useToast';
import { usePuzzleState } from './hooks/usePuzzleState';
import './App.css';

const FLOW_HELP_CLOSE_MS = 200;
const THEME_STORAGE_KEY = 'puzzle-ui-theme';

type ThemeMode = 'light' | 'dark';

/** Split help copy on sentence boundaries for modal paragraphs. */
function splitHelpParagraphs(text: string): string[] {
  const chunks = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : [text];
}

function App() {
  const { toast, showToast, clearToast } = useToast();
  const puzzle = usePuzzleState(showToast);

  const [showHelp, setShowHelp] = useState(false);
  const [helpClosing, setHelpClosing] = useState(false);
  const helpPanelRef = useRef<HTMLDivElement>(null);
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const closeHelpModal = useCallback(() => {
    setHelpClosing(true);
  }, []);

  useEffect(() => {
    if (!helpClosing) return;
    const t = window.setTimeout(() => {
      setShowHelp(false);
      setHelpClosing(false);
    }, FLOW_HELP_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [helpClosing]);

  useEffect(() => {
    if (!showHelp || helpClosing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHelpModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHelp, helpClosing, closeHelpModal]);

  useEffect(() => {
    if (!showHelp || helpClosing) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    helpCloseRef.current?.focus();

    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const panel = helpPanelRef.current;
      if (!panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [showHelp, helpClosing]);

  useEffect(() => {
    if (!showHelp) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showHelp]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  const isTestMode = import.meta.env.VITE_USE_MOCK_API === 'true' || import.meta.env.VITE_USE_MOCK_API === '1';
  const isDarkMode = themeMode === 'dark';

  const headerConfig = useMemo(() => {
    switch (puzzle.currentPage) {
      case 'home':
        return { showBackToUpload: false, helpTitle: '', helpContent: '' };
      case 'crop':
        return { 
          showBackToUpload: true,
          helpTitle: 'Crop Image',
          helpContent: 'Adjust the crop area to focus on just the puzzle pieces. Drag the corners or edges of the selection box to resize it. The crop should include all 9 puzzle pieces arranged in a 3x3 grid. Click "Submit" when ready to continue.'
        };
      case 'boundingBox':
        return { 
          showBackToUpload: true,
          helpTitle: 'Adjust Bounding Boxes',
          helpContent: 'Fine-tune the bounding boxes around each puzzle piece. Drag the corners to resize each box so it tightly fits around the piece. Click "Submit" when all boxes are correctly positioned.'
        };
      case 'clusterOrganizing':
        return { 
          showBackToUpload: true,
          helpTitle: 'Organize Clusters',
          helpContent: 'The puzzle edge triangles have been grouped by their patterns. Drag images between groups to correct any misclassifications - each group should contain triangles with matching patterns. Click "Submit" when all groups are correctly organized.'
        };
      case 'clusterMatching':
        return { 
          showBackToUpload: true,
          helpTitle: 'Match Images',
          helpContent: 'Arrange the image groups so that matching images are paired vertically - the top and bottom images in each column should match. Drag images to swap their positions until all columns have matching pairs. Click "Solve" when done.'
        };
      case 'solve':
        return { 
          showBackToUpload: true,
          helpTitle: 'Solution',
          helpContent: 'This page shows the solved puzzle arrangement. The left side shows the original pieces, and the right shows how they should be arranged to solve the puzzle. Use "Toggle Labels" to see piece numbers and rotations.'
        };
      case 'play':
        return { 
          showBackToUpload: true,
          helpTitle: '',
          helpContent: ''
        };
      default:
        return { showBackToUpload: false, helpTitle: '', helpContent: '' };
    }
  }, [puzzle.currentPage]);

  const renderPage = () => {
    switch (puzzle.currentPage) {
      case 'home':
        return (
          <LandingPage
            onImageSelect={puzzle.handleImageSelect}
            onBuiltInImageSelect={puzzle.handleBuiltInImageSelect}
            onPlayClick={puzzle.handlePlayClick}
            disabled={puzzle.isLoading}
            onShowToast={showToast}
          />
        );

      case 'crop':
        if (!puzzle.uploadedFile) return null;
        return (
          <CropPage
            key={`${puzzle.uploadedFile.name}-${puzzle.uploadedFile.size}-${puzzle.uploadedFile.lastModified}`}
            imageFile={puzzle.uploadedFile}
            onCrop={puzzle.handleCropApply}
            onCancel={puzzle.handleCropCancel}
            onShowToast={showToast}
          />
        );

      case 'boundingBox':
        if (!puzzle.croppedImageUrl) return null;
        return (
          <BoundingBoxPage
            imageUrl={puzzle.croppedImageUrl}
            boundingBoxes={puzzle.boundingBoxes}
            onBoundingBoxesChange={puzzle.handleBoundingBoxesChange}
            onBack={puzzle.handleBackToCrop}
            onReset={puzzle.handleReset}
            onUndo={puzzle.handleUndo}
            onSubmit={puzzle.handleSubmitBoundingBoxes}
            canUndo={puzzle.canUndo}
            canSubmit={puzzle.canSubmit}
            isLoading={puzzle.isLoading}
            onShowToast={showToast}
          />
        );

      case 'clusterOrganizing':
        if (!puzzle.submittedData) return null;
        return (
          <ClusterOrganizingPage
            submittedData={puzzle.submittedData}
            initialClusters={puzzle.modifiedClusters}
            onEdit={puzzle.handleEditBoundingBoxes}
            onSubmit={puzzle.handleOrganizingSubmit}
            isSubmitting={puzzle.isLoading}
            onShowToast={showToast}
          />
        );

      case 'clusterMatching':
        if (!puzzle.submittedData || !puzzle.modifiedClusters || !puzzle.modifiedMatchingOrder) return null;
        return (
          <ClusterMatchingPage
            submittedData={puzzle.submittedData}
            clusters={puzzle.modifiedClusters}
            initialMatchingOrder={puzzle.modifiedMatchingOrder}
            onBack={puzzle.handleBackToOrganizing}
            onSolve={puzzle.handleSolve}
            onShowToast={showToast}
          />
        );

      case 'solve':
        if (!puzzle.submittedData || !puzzle.puzzleInfoResponse) return null;
        return (
          <SolvePage
            submittedData={puzzle.submittedData}
            puzzleInfoResponse={puzzle.puzzleInfoResponse}
            onBack={puzzle.handleBackToClusterMatching}
            onStartOver={puzzle.handleStartOver}
          />
        );

      case 'play':
        return (
          <PlayPage
            puzzleId={puzzle.playPuzzleId}
            puzzleName={puzzle.playPuzzleName}
            onBack={puzzle.handleBackFromPlay}
            onShowToast={showToast}
          />
        );

      default:
        return null;
    }
  };

  const isHome = puzzle.currentPage === 'home';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <h1>
            <button
              type="button"
              className={headerConfig.showBackToUpload ? 'app-title-clickable' : 'app-title-static'}
              onClick={headerConfig.showBackToUpload ? puzzle.handleBackToUpload : undefined}
              disabled={!headerConfig.showBackToUpload}
              aria-label={headerConfig.showBackToUpload ? 'Back to upload' : undefined}
            >
              <img src="/puzzle-logo.svg" alt="" className="app-logo" />
              Scramble Squares Solver
            </button>
          </h1>
        </div>
        <div className="app-header-right">
          <button
            type="button"
            className="theme-toggle-button"
            onClick={() => setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDarkMode ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M21 12.79A9 9 0 1 1 11.21 3c.2 0 .4.02.59.05a1 1 0 0 1 .46 1.73A7 7 0 0 0 19.22 16.8a1 1 0 0 1 1.73.46c.03.19.05.39.05.59z" />
              </svg>
            )}
          </button>
          {isHome ? (
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer noopener"
              className="app-header-cta"
            >
              Learn More
            </a>
          ) : (
            <>
              {headerConfig.helpContent && (
                <button
                  className="help-button"
                  onClick={() => setShowHelp(true)}
                  aria-label="Help"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" strokeLinecap="round"/>
                    <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" strokeWidth="3"/>
                  </svg>
                </button>
              )}
              {isTestMode && (
                <span className="test-mode-badge" title="Using mock API - no backend connection">
                  TEST MODE
                </span>
              )}
            </>
          )}
        </div>
      </header>

      <main className={`app-main ${isHome ? 'app-main--landing' : ''}`}>
        <ErrorBoundary>
          {renderPage()}
        </ErrorBoundary>
      </main>

      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type || 'error'}
          onClose={clearToast}
        />
      )}

      {showHelp && headerConfig.helpContent && (
        <div
          className={`flow-help-overlay${helpClosing ? ' flow-help-overlay--closing' : ''}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeHelpModal();
          }}
          role="presentation"
        >
          <div
            ref={helpPanelRef}
            className={`flow-help-panel${helpClosing ? ' flow-help-panel--closing' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="flow-help-title"
            tabIndex={-1}
          >
            <header className="flow-help-header">
              <h2 id="flow-help-title" className="flow-help-title">
                {headerConfig.helpTitle}
              </h2>
              <button
                ref={helpCloseRef}
                type="button"
                className="flow-help-close"
                onClick={closeHelpModal}
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </header>
            <div className="flow-help-body">
              {splitHelpParagraphs(headerConfig.helpContent).map((block, i) => (
                <p key={i} className="flow-help-block">
                  {block}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
