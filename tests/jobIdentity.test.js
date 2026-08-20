import test from "node:test";
import assert from "node:assert/strict";
import { isJobResumable, jobSettingsFingerprint } from "../src/core/jobIdentity.js";

const SCHEMA = 3;

test("jobSettingsFingerprint distinguishes lookback window, seek-resume, and timeline-backfill independently", () => {
  const base = { communityId: "1", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  assert.notEqual(
    jobSettingsFingerprint(base),
    jobSettingsFingerprint({ ...base, lookbackDays: 90 })
  );
  assert.notEqual(
    jobSettingsFingerprint(base),
    jobSettingsFingerprint({ ...base, seekResume: true })
  );
  assert.notEqual(
    jobSettingsFingerprint(base),
    jobSettingsFingerprint({ ...base, timelineBackfill: false })
  );
  assert.equal(jobSettingsFingerprint(base), jobSettingsFingerprint({ ...base }));
});

test("isJobResumable accepts a job whose schema and settings both match", () => {
  const job = { schema: SCHEMA, communityId: "1", lookbackDays: 30, seekResume: true, timelineBackfill: true };
  const current = { communityId: "1", lookbackDays: 30, seekResume: true, timelineBackfill: true };
  assert.equal(isJobResumable(job, current, SCHEMA), true);
});

test("isJobResumable rejects a 90-day job being resumed under a 30-day setting", () => {
  const job = { schema: SCHEMA, communityId: "1", lookbackDays: 90, seekResume: false, timelineBackfill: true };
  const current = { communityId: "1", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  assert.equal(isJobResumable(job, current, SCHEMA), false);
});

test("isJobResumable rejects a job written under an older schema even if every field happens to match", () => {
  const job = { schema: SCHEMA - 1, communityId: "1", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  const current = { communityId: "1", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  assert.equal(isJobResumable(job, current, SCHEMA), false);
});

test("isJobResumable rejects a null or missing job outright", () => {
  const current = { communityId: "1", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  assert.equal(isJobResumable(null, current, SCHEMA), false);
  assert.equal(isJobResumable(undefined, current, SCHEMA), false);
});

test("isJobResumable rejects a different Community even with identical other settings", () => {
  const job = { schema: SCHEMA, communityId: "1", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  const current = { communityId: "2", lookbackDays: 30, seekResume: false, timelineBackfill: true };
  assert.equal(isJobResumable(job, current, SCHEMA), false);
});
