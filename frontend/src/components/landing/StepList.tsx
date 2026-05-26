import { Fragment, useState } from 'react';

/** Tiny syntax-colored `<pre>` for example JSON in step copy. */
function JsonBlock({ code }: { code: string }) {
  // Minimal JSON syntax highlighting: keys, numbers, punctuation.
  // eslint-disable-next-line no-useless-escape -- `[\]` inside the class are bracket literals
  const tokens = code.split(/("(?:[^"\\]|\\.)*"|\b\d+\b|[{}\[\],:])/);
  return (
    <pre className="landing-step-code-block">
      <code>
        {tokens.map((tok, i) => {
          if (/^"/.test(tok)) {
            const isKey = tokens[i + 1]?.trimStart().startsWith(':');
            return <span key={i} className={isKey ? 'jk' : 'js'}>{tok}</span>;
          }
          if (/^\d+$/.test(tok)) return <span key={i} className="jn">{tok}</span>;
          if (['{', '}', '[', ']'].includes(tok)) return <span key={i} className="jp">{tok}</span>;
          return tok;
        })}
      </code>
    </pre>
  );
}

type StepVisual = {
  src?: string;
  alt?: string;
  code?: string;
  caption: string;
};

type DetailStep = {
  heading: string;
  body: string;
};

type Step = {
  num: number;
  title: string;
  preview: string;
  details: string;
  detailSteps?: DetailStep[];
  visualLayout: 'single' | 'sequence' | 'grid' | 'none';
  visuals: StepVisual[];
};

const STEPS: Step[] = [
  {
    num: 1,
    title: 'Piece detection',
    preview: 'Detect puzzle pieces in the uploaded photo and estimate a clean bounding box for each one.',
    details:
      'The image goes through a vision pipeline (color conversion, thresholding, cleanup, contour filtering) until piece candidates are stable. The result is a set of piece crops and indexed bounding boxes.',
    visualLayout: 'sequence',
    visuals: [
      {
        src: '/how-it-works/step1-photo-input.png',
        alt: 'Example uploaded puzzle photo used as input to piece detection.',
        caption: 'Uploaded photo',
      },
      {
        src: '/how-it-works/step1-foreground-mask.png',
        alt: 'Foreground mask separating puzzle pieces from the background.',
        caption: 'Foreground mask',
      },
      {
        src: '/how-it-works/step1-piece-boxes.png',
        alt: 'Detected piece candidates with indexed bounding boxes.',
        caption: 'Indexed piece boxes',
      },
    ],
  },
  {
    num: 2,
    title: 'Edge isolation',
    preview: 'Warp each detected piece to a normalized square, then split it into four directional edge triangles.',
    details:
      'Perspective correction maps each piece to a canonical square first. From there, the piece is split into top/right/bottom/left edge triangles so each side can be analyzed independently.',
    visualLayout: 'sequence',
    visuals: [
      {
        src: '/how-it-works/step2-piece-warp-input.png',
        alt: 'Detected puzzle piece before perspective normalization.',
        caption: 'Detected piece crop',
      },
      {
        src: '/how-it-works/step2-piece-warped.png',
        alt: 'Warped square piece after perspective correction.',
        caption: 'Warped to square',
      },
      {
        src: '/how-it-works/step2-edge-triangles.png',
        alt: 'Square piece split into top, right, bottom, and left edge triangles.',
        caption: 'Split into edge triangles',
      },
    ],
  },
  {
    num: 3,
    title: 'Edge grouping',
    preview:
      'Thirty-six edge triangles each get a MobileNetV2 embedding, then we partition them into eight clusters so edges that show the same image in their crop are grouped together.',
    details:
      'A 3×3 puzzle has 36 edges—four per piece. MobileNetV2 is pretrained on ImageNet; here it is only a feature extractor, producing one pooled vector per masked edge triangle. We measure cosine distance between those vectors, run agglomerative clustering with complete linkage, cut to eight clusters for this puzzle size, and refine with k-medoids. A cluster gathers edges whose triangle crops show the same image; grouping follows visual similarity in embedding space, not piece labels or edge geometry.',
    visualLayout: 'sequence',
    visuals: [
      {
        src: '/how-it-works/step3-edge-samples.png',
        alt: 'Vertical strips: each column is one edge embedding with dimensions top to bottom, sorted by cluster; colored bar at left indicates cluster.',
        caption: 'Embedding vectors',
      },
      {
        src: '/how-it-works/step3-similarity-matrix.png',
        alt: 'Pairwise cosine distance matrix between edge triangles, sorted by cluster.',
        caption: 'Cosine distance matrix',
      },
      {
        src: '/how-it-works/step3-cluster-groups.png',
        alt: 'Edge triangles arranged by final cluster assignment.',
        caption: 'Cluster assignments',
      },
    ],
  },
  {
    num: 4,
    title: 'Edge matching',
    preview:
      'Pick one representative edge per cluster, build a color profile for each, then find the four cluster pairs with the most similar colors.',
    details:
      'One representative triangle is chosen from each of the eight clusters. A color histogram is built for each representative in LAB colorspace—a perceptually uniform model that separates lightness from color. Bins that appear frequently across all edges are downweighted so common background tones matter less and distinctive colors count more. The four disjoint pairs with the smallest total color distance are selected as the matched pairs.',
    visualLayout: 'sequence',
    visuals: [
      {
        src: '/how-it-works/step4-cluster-representatives.png',
        alt: 'One representative masked edge triangle per cluster.',
        caption: 'Cluster representatives',
      },
      {
        src: '/how-it-works/step4-color-profiles.png',
        alt: 'Dominant colors from each representative edge crop, segment width by pixel share.',
        caption: 'Color signatures',
      },
      {
        src: '/how-it-works/step4-matched-pairs.png',
        alt: 'Same cluster grid as representatives with black outlines grouping matched pairs.',
        caption: 'Pair grouping',
      },
    ],
  },
  {
    num: 5,
    title: 'Constraint solving',
    preview: 'Try every valid placement of pieces and rotations, pruning branches that violate edge constraints early.',
    details: '',
    detailSteps: [
      {
        heading: 'Generate candidates',
        body: 'Every piece is considered in all four rotations, giving 36 candidate piece-rotations across 9 grid positions.',
      },
      {
        heading: 'Pick the most constrained position',
        body: 'The solver always picks the grid position with the fewest remaining candidates. This cuts the search space aggressively from the start.',
      },
      {
        heading: 'Place a piece and propagate',
        body: 'Placing a piece removes it from every other position\'s candidate set. Adjacent positions are also updated—only pieces whose edge cluster matches the placed piece\'s edge remain valid.',
      },
      {
        heading: 'Backtrack on dead ends',
        body: 'If any position is left with zero candidates, that branch is invalid. The solver backtracks and tries the next candidate, never exploring paths that cannot lead to a solution.',
      },
      {
        heading: 'Collect all solutions',
        body: 'The search continues until all positions are filled. Multiple valid solutions may exist; the best match given any already-placed pieces is returned.',
      },
    ],
    visualLayout: 'none',
    visuals: [],
  },
  {
    num: 6,
    title: 'Reconstruction',
    preview: 'Feed the puzzle photo into the solver and get back a JSON solution mapping each piece to a grid position and rotation.',
    details:
      'After solving, the API returns a positions map (which grid cell each piece belongs in) and a rotations map (how many 90° turns to apply). The UI reads those values and renders the pieces into a solved grid so the result is easy to follow and replicate physically.',
    visualLayout: 'sequence',
    visuals: [
      {
        src: '/how-it-works/step6-input-photo.png',
        alt: 'The original puzzle photo used as input to the solver.',
        caption: 'Input photo',
      },
      {
        code: `{
  "bestSolution": {
    "positions": {
      "0": 4, "1": 0, "2": 7,
      "3": 6, "4": 8, "5": 1,
      "6": 3, "7": 5, "8": 2
    },
    "rotations": {
      "0": 0, "1": 2, "2": 1,
      "3": 3, "4": 0, "5": 1,
      "6": 2, "7": 0, "8": 3
    }
  },
  "solutions": [ ... ]
}`,
        caption: 'Solve API response',
      },
      {
        src: '/how-it-works/step6-reconstructed.png',
        alt: 'The reconstructed puzzle image with piece labels showing correct positions and rotations.',
        caption: 'Reconstructed puzzle',
      },
    ],
  },
];

/** Accordion list of pipeline steps with previews and detail panels. */
export function StepList() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (stepNum: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(stepNum)) {
        next.delete(stepNum);
      } else {
        next.add(stepNum);
      }
      return next;
    });
  };

  return (
    <div className="landing-step-list">
      {STEPS.map((step) => (
        <div key={step.num} className={`landing-step-item ${expanded.has(step.num) ? 'expanded' : ''}`}>
          <div className="landing-step-header">
            <div className="landing-step-num">{step.num}</div>
            <div className="landing-step-content">
              <h4>{step.title}</h4>
              <p className="landing-step-preview">{step.preview}</p>
            </div>
            <button
              type="button"
              className={`landing-step-toggle ${expanded.has(step.num) ? 'expanded' : ''}`}
              aria-expanded={expanded.has(step.num)}
              aria-controls={`step-details-${step.num}`}
              onClick={() => toggle(step.num)}
              title={expanded.has(step.num) ? 'Collapse section' : 'Expand section'}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8l8 8 8-8" />
              </svg>
            </button>
          </div>
          <div
            id={`step-details-${step.num}`}
            className={`landing-step-details-wrap ${expanded.has(step.num) ? 'expanded' : ''}`}
            aria-hidden={!expanded.has(step.num)}
          >
            <div className="landing-step-details-inner">
              {step.detailSteps ? (
                <ol className="landing-step-detail-steps">
                  {step.detailSteps.map((s) => (
                    <li key={s.heading} className="landing-step-detail-step">
                      <span className="landing-step-detail-heading">{s.heading}</span>
                      <span className="landing-step-detail-body">{s.body}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="landing-step-details">{step.details}</p>
              )}
              {step.visualLayout !== 'none' && <div className="landing-step-visual">
                {step.visualLayout === 'single' ? (
                  <div className="landing-step-visual-single-wrap">
                    <div className="landing-step-visual-frame landing-step-visual-frame-single">
                      <img src={step.visuals[0].src} alt={step.visuals[0].alt} />
                    </div>
                    <div className="landing-step-visual-caption">{step.visuals[0].caption}</div>
                  </div>
                ) : step.visualLayout === 'sequence' ? (
                  <div
                    className={`landing-step-visual-gallery landing-step-visual-gallery-sequence${
                      step.num <= 2
                        ? ' landing-step-visual-gallery-sequence--square-slots'
                        : ' landing-step-visual-gallery-sequence--uniform-row'
                    }`}
                  >
                    {step.visuals.map((visual, index) => (
                      <Fragment key={visual.caption}>
                        <div className="landing-step-visual-card">
                          <div className="landing-step-visual-slot">
                            <div className={`landing-step-visual-frame${visual.code ? ' landing-step-visual-frame--code' : ''}`}>
                              {visual.code
                                ? <JsonBlock code={visual.code} />
                                : <img src={visual.src} alt={visual.alt} />
                              }
                            </div>
                          </div>
                          <div className="landing-step-visual-caption">{visual.caption}</div>
                        </div>
                        {index < step.visuals.length - 1 && (
                          <span className="landing-step-visual-separator" aria-hidden>
                            →
                          </span>
                        )}
                      </Fragment>
                    ))}
                  </div>
                ) : (
                  <div className="landing-step-visual-gallery landing-step-visual-gallery-grid">
                    {step.visuals.map((visual) => (
                      <div key={visual.src} className="landing-step-visual-card-wrap">
                        <div className="landing-step-visual-card">
                          <div className="landing-step-visual-slot">
                            <div className="landing-step-visual-frame">
                              <img src={visual.src} alt={visual.alt} />
                            </div>
                          </div>
                          <div className="landing-step-visual-caption">{visual.caption}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
