// A resumed scan job must match not just the Community but the settings
// that shaped what was actually collected. A checkpoint built for a 90-day
// lookback with seek-resume on must never be silently reused as though it
// answered a 30-day lookback with seek-resume off - the roster and activity
// data underneath would be real, just an answer to a different question
// than the one currently being asked.

export function jobSettingsFingerprint({ communityId, lookbackDays, seekResume, timelineBackfill } = {}) {
  return [
    String(communityId ?? ""),
    String(lookbackDays ?? ""),
    seekResume ? "seek" : "noseek",
    timelineBackfill ? "backfill" : "nobackfill",
  ].join("|");
}

// `expectedSchema` is checked first and separately from the fingerprint so
// an old job record - written before these fields existed at all - fails
// closed on the schema mismatch rather than on an accidental fingerprint
// coincidence, matching how this project's other checkpoints (see
// CURSOR_CHECKPOINT_SCHEMA's own history) invalidate stale records
// explicitly rather than reinterpreting them under new semantics.
export function isJobResumable(job, currentSettings, expectedSchema) {
  if (!job || job.schema !== expectedSchema) return false;
  return jobSettingsFingerprint(job) === jobSettingsFingerprint(currentSettings);
}
