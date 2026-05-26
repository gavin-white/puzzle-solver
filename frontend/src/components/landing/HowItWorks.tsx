import { StepList } from './StepList';

/** “How it works” section with expandable pipeline steps. */
export function HowItWorks() {
  return (
    <section id="how-it-works" className="landing-how-section">
      <div className="landing-section-header">
        <h2>How it works</h2>
        <p>From photo to solution: the pipeline step by step.</p>
      </div>
      <div className="landing-how-single">
        <StepList />
      </div>
    </section>
  );
}
