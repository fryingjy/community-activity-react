import { resumeScan, discardScan } from "../scanEngine.js";

export function ResumePanel({ job }) {
  if (!job) return null;
  return (
    <section className="card resume-card">
      <div className="card-heading">
        <div>
          <span className="kicker">Incomplete scan found</span>
          <h2>Community {job.communityId}</h2>
        </div>
        <span className="live-badge stopped">
          <i aria-hidden="true" />
          <span>{job.statusLabel}</span>
        </span>
      </div>
      <p className="coverage">{job.summaryText}</p>
      <ol className="resume-stage-list" aria-label="Saved scan stages">
        {job.stages.map((stage) => (
          <li key={stage.label} className={`resume-stage is-${stage.status}`} title={stage.resumeHint}>
            <span className="resume-stage-dot" aria-hidden="true" />
            <span className="resume-stage-name">{stage.label}</span>
            <span className="resume-stage-status">{stage.statusText}</span>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="primary" onClick={() => void resumeScan()}>
          <span>Resume scan</span>
          <i aria-hidden="true">→</i>
        </button>
        <button type="button" className="secondary" onClick={() => void discardScan()}>
          Discard resume
        </button>
      </div>
      <small>
        <strong>Discard resume</strong> only forgets this notice — every stage's own saved
        checkpoint (roster pages, activity cursor, verification cache) stays in place and a
        new scan can still silently reuse it. It does not delete anything already exported,
        and it is not the same as <strong>Clear this Community</strong> or{" "}
        <strong>Clear all Community Activity data</strong> in the Storage section below,
        which do remove those checkpoints.
      </small>
    </section>
  );
}
