// Every X GraphQL operation this extension depends on is a persisted query
// identified by an opaque document ID X can retire or rewrite without
// warning (operations.js's own comments note this happened once already).
// KNOWN_OPERATIONS names each one and the capability it serves, purely as a
// static catalog for diagnostics/UI use — it is not consulted by the
// scanner itself, which still resolves the concrete documentId/operation
// pair it calls from operations.js or a discovered live operation.
export const KNOWN_OPERATIONS = Object.freeze([
  { name: "CommunityQuery", role: "community-info" },
  { name: "CommunitiesMembersAllQuery", role: "native-roster" },
  { name: "membersSliceTimeline_Query", role: "web-roster-fallback" },
  { name: "moderatorsSliceTimeline_Query", role: "moderators" },
  { name: "CommunityMemberRelationshipTypeahead", role: "membership-verification" },
  { name: "CommunityAnalyticsQuery", role: "analytics" },
  { name: "CommunityTweetsTimeline", role: "timeline" },
  { name: "CommunityMediaTimeline", role: "media" },
  { name: "CommunityAboutTimeline", role: "about" },
  { name: "CommunityTweetSearchModuleQuery", role: "search-verification" },
]);

// Health is derived from real scan traffic, not a dedicated startup probe:
// spending extra requests just to check "is this contract alive" before
// every scan would cost real quota for no benefit when the scan is about to
// call every operation it needs anyway. graphqlClient.js reports outcomes
// here as they happen.
export class OperationRegistry {
  // `state` is the same plain object requestStats.operations already points
  // at, wrapped by reference - see QuotaManager for the identical pattern
  // and why (diagnostics.js and any future reader keep working unchanged).
  constructor(state = {}) {
    this.state = state;
  }

  recordSuccess(name) {
    this.state[name] = { status: "ok", reason: null, checkedAt: Date.now() };
  }

  // `reason` should only ever describe a genuine contract problem - a stale
  // persisted document ID, a removed feature switch, X rejecting the
  // operation outright. Network blips, rate limits, and session/auth
  // failures are not contract signals and must not be recorded here: they
  // say nothing about whether this specific operation still exists.
  recordContractFailure(name, reason) {
    this.state[name] = { status: "broken", reason, checkedAt: Date.now() };
  }

  get(name) {
    return this.state[name] || { status: "unknown", reason: null, checkedAt: null };
  }

  snapshot() {
    return this.state;
  }
}
