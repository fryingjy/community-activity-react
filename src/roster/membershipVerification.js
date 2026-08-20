import { graphqlGet } from "../api/graphqlClient.js";
import { AdaptiveRateLimiter } from "../api/rateLimiter.js";
import { planWork } from "../api/quotaPlanner.js";
import { MEMBER_RELATIONSHIP_OPERATION } from "../api/operations.js";
import { StoppedError } from "../core/errors.js";
import { firstKey, findUserResult } from "./graphqlTree.js";
import { packMember, unpackMember } from "./memberCodec.js";

export function parseCommunityMemberRelationshipPayload(payload, candidate) {
  const result = firstKey(payload, "member_relationship_typeahead");
  const relationships = Array.isArray(result.value) ? result.value : [];
  const candidateId = candidate?.user_id ? String(candidate.user_id) : null;
  const candidateUsername = String(candidate?.username || "").toLowerCase();
  for (const relationship of relationships) {
    const user = findUserResult(relationship);
    const username = user?.core?.screen_name || user?.legacy?.screen_name;
    const userId = user?.rest_id || user?.id_str || null;
    if (!username) continue;
    const exactMatch = candidateId
      ? String(userId || "") === candidateId
      : username.toLowerCase() === candidateUsername;
    if (!exactMatch) continue;
    // The July 2026 web contract places the relationship role directly on
    // each typeahead item. Older clients embedded it as community_role.
    const role =
      relationship?.role ||
      firstKey(relationship, "community_role").value ||
      "NonMember";
    if (String(role).toLowerCase() === "nonmember") return null;
    return {
      username,
      name: user.core?.name || user.legacy?.name || username,
      user_id: userId,
      role,
      protected: typeof user.privacy?.protected === "boolean"
        ? user.privacy.protected
        : typeof user.legacy?.protected === "boolean"
          ? user.legacy.protected
          : null,
      roleConfidence: "high",
      source: "relationship-verification",
      membershipEvidence: "x-roster",
    };
  }
  return null;
}

const MEMBERSHIP_VERIFICATION_SCHEMA = 2;
const MEMBERSHIP_VERIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function verificationKey(communityId) {
  return `membershipVerification:${communityId}`;
}

function candidateIdentity(candidate) {
  return candidate?.user_id
    ? `id:${String(candidate.user_id)}`
    : `username:${String(candidate?.username || "").toLowerCase()}`;
}

export async function verifyKnownCommunityMembers(
  communityId,
  candidates,
  {
    signal,
    requestStats,
    log,
    onProgress,
    // Used only when this operation's quota has not been observed yet in
    // this scan. Once headers have been seen, planWork() uses the actual
    // remaining budget and keeps a reserve for retries or other work.
    maxCandidatesPerRun = 350,
    limiter: injectedLimiter,
    delayFn,
  } = {}
) {
  const key = verificationKey(communityId);
  const stored = (await chrome.storage.local.get(key))[key];
  const entries = [1, MEMBERSHIP_VERIFICATION_SCHEMA].includes(stored?.schema) &&
    stored.entries &&
    typeof stored.entries === "object"
    ? { ...stored.entries }
    : {};
  const now = Date.now();
  const pending = new Map();
  if (stored?.schema === MEMBERSHIP_VERIFICATION_SCHEMA && Array.isArray(stored.pending)) {
    for (const row of stored.pending) {
      const candidate = unpackMember(row);
      if (candidate?.username) pending.set(candidateIdentity(candidate), candidate);
    }
  }
  for (const candidate of candidates || []) {
    if (!candidate?.username) continue;
    const identity = candidateIdentity(candidate);
    if (!identity) continue;
    const previous = entries[identity];
    if (previous?.checkedAt && now - previous.checkedAt <= MEMBERSHIP_VERIFICATION_MAX_AGE_MS) {
      pending.delete(identity);
      continue;
    }
    pending.set(identity, candidate);
  }
  const queue = [...pending.values()];

  const limiter = injectedLimiter || new AdaptiveRateLimiter(1250);
  const observedQuota = requestStats?.quotas?.[MEMBER_RELATIONSHIP_OPERATION.operation] || null;
  const plan = planWork(queue.length, observedQuota, {
    unknownQuotaFallback: maxCandidatesPerRun,
  });
  let checked = 0;
  let confirmed = Object.values(entries).filter((entry) => Array.isArray(entry?.member)).length;
  let stoppedReason = queue.length ? plan.reason : "up-to-date";
  let terminalError = null;
  try {
    for (const candidate of queue.slice(0, plan.processNow)) {
      if (signal?.aborted) throw new StoppedError();
      const identity = candidateIdentity(candidate);
      try {
        const payload = await graphqlGet(
          MEMBER_RELATIONSHIP_OPERATION.documentId,
          MEMBER_RELATIONSHIP_OPERATION.operation,
          {
            communityId,
            prefix: candidate.username,
          },
          null,
          {
            signal,
            requestStats,
            log,
            limiter,
            maxAttempts: 3,
            delayFn,
          }
        );
        const member = parseCommunityMemberRelationshipPayload(payload, candidate);
        if (!Array.isArray(entries[identity]?.member) && member) confirmed++;
        entries[identity] = {
          checkedAt: Date.now(),
          member: member ? packMember(member) : null,
        };
        pending.delete(identity);
        checked++;
        if (checked % 10 === 0) {
          await chrome.storage.local.set({
            [key]: {
              schema: MEMBERSHIP_VERIFICATION_SCHEMA,
              updatedAt: Date.now(),
              entries,
              pending: [...pending.values()].map(packMember),
            },
          });
        }
        onProgress?.({
          checked,
          queued: queue.length,
          confirmed,
          scheduled: plan.processNow,
        });
      } catch (error) {
        if (error instanceof StoppedError || error?.name === "StoppedError") throw error;
        terminalError = error;
        stoppedReason = error?.code === "rate-limited" ? "rate-limited" : "request-error";
        break;
      }
    }
  } finally {
    // An interruption can land between periodic saves. Persist every completed
    // lookup so a restart resumes at the exact queue offset without spending
    // extra requests re-verifying the same members.
    await chrome.storage.local.set({
      [key]: {
        schema: MEMBERSHIP_VERIFICATION_SCHEMA,
        updatedAt: Date.now(),
        entries,
        pending: [...pending.values()].map(packMember),
      },
    });
  }

  if (!terminalError && checked >= queue.length) stoppedReason = "queue-complete";
  const members = Object.values(entries)
    .filter(
      (entry) =>
        Array.isArray(entry?.member) &&
        entry.checkedAt &&
        now - entry.checkedAt <= MEMBERSHIP_VERIFICATION_MAX_AGE_MS
    )
    .map((entry) => ({
      ...unpackMember(entry.member),
      source: "relationship-verification",
      membershipEvidence: "x-roster",
    }));
  return {
    members,
    checked,
    queued: queue.length,
    remaining: pending.size,
    reason: stoppedReason,
    error: terminalError,
    scheduled: plan.processNow,
    quota: { usable: plan.usable, resetAt: plan.resetAt },
  };
}
