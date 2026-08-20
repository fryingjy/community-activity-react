// This file is a re-export barrel. The real implementation lives under
// src/ (api/, core/, roster/, activity/, export/) as of the 5.14 module
// split; this file exists only so every existing import path — sidepanel.js,
// the test suite, and anyone consuming this project as a library — keeps
// working unchanged. See README.md for the module map and the rationale for
// each boundary.

export { StoppedError } from "./src/core/errors.js";
export { calendarActivityWindow } from "./src/core/time.js";
export { ScanCoordinator } from "./src/core/scanCoordinator.js";
export {
  summarizeScanCompleteness,
  determineActionability,
} from "./src/core/scanCompleteness.js";
export {
  InvariantViolation,
  assertActivityVerificationIsKnown,
  assertAutomatedRemovalRequiresCompleteActivity,
  assertConfirmedOnlyRowsAreConfirmed,
  assertEveryMemberHasAResolvableIdentity,
  assertNoDuplicateMemberIdentities,
} from "./src/core/invariants.js";

export { AdaptiveRateLimiter } from "./src/api/rateLimiter.js";
export { NATIVE_MEMBERS_ALL_OPERATION } from "./src/api/operations.js";
export { KNOWN_OPERATIONS, OperationRegistry } from "./src/api/operationRegistry.js";
export { planWork, usableQuota } from "./src/api/quotaPlanner.js";
export { isJobResumable, jobSettingsFingerprint } from "./src/core/jobIdentity.js";
export { summarizeResumableJob } from "./src/core/resumeSummary.js";
export {
  computeCommunityStorageKeys,
  estimateStorageBytes,
  keyBelongsToCommunity,
  summarizeStorageByCommunity,
} from "./src/core/storageInventory.js";
export { estimateActivityThroughput, pushSample } from "./src/core/activityThroughput.js";

export {
  seekResumeForwardStep,
  readRosterCursorTimestamp,
  withRosterCursorTimestamp,
} from "./src/roster/cursorCodec.js";
export {
  SEEK_RESUME_IDLE_PAGE_LIMIT,
  shouldResumeChain,
  resolveRosterStopReason,
} from "./src/roster/seekResume.js";
export {
  parseCommunityMembersTimelinePayload,
  parseCommunityMembersCursorPayload,
} from "./src/roster/rosterParser.js";
export {
  buildMemberCursorRequest,
  fetchCommunityMembersByCursor,
} from "./src/roster/collectRoster.js";
export {
  parseCommunityModeratorsPayload,
  fetchCommunityModerators,
} from "./src/roster/moderators.js";
export {
  fetchCommunityInfo,
  parseCommunityAnalyticsPayload,
  fetchCommunityAnalytics,
} from "./src/roster/communityInfo.js";
export {
  parseCommunityMemberRelationshipPayload,
  verifyKnownCommunityMembers,
} from "./src/roster/membershipVerification.js";
export { fetchCommunityAboutMembers } from "./src/roster/aboutMembers.js";

export {
  communityActivityKind,
  parseCommunityTimelinePage,
} from "./src/activity/timelineParser.js";
export {
  activityDetailsForMember,
  activityCountForMember,
  annotateMemberActivity,
  classifyFlaggedMember,
  classifySearchVerification,
} from "./src/activity/classification.js";
export { fetchActiveAuthors } from "./src/activity/timelineCollector.js";
export { backfillCommunityTimelineAuthors } from "./src/activity/timelineBackfill.js";
export { backfillCommunityMediaAuthors } from "./src/activity/mediaCollector.js";
export { backfillCommunitySearchAuthors } from "./src/activity/searchDiscovery.js";
export {
  activitySearchCandidateIdentity,
  buildActivitySearchVariables,
  latestCommunityPostAt,
  verifyMemberActivityViaSearch,
} from "./src/activity/directVerification.js";

export {
  buildCsv,
  buildFlaggedUsernamesText,
  buildPrivateAccountsCsv,
  buildPrivateAccountsText,
  downloadBlob,
} from "./src/export/csv.js";
