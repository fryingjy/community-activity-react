import { graphqlGet } from "../api/graphqlClient.js";
import { DOCUMENT_IDS, COMMUNITY_FEATURES } from "../api/operations.js";
import { firstKey } from "./graphqlTree.js";
import { parseCommunityInfoPayload } from "../../graphqlContracts.js";

export async function fetchCommunityInfo(communityId, options = {}) {
  const { operation, ...requestOptions } = options;
  const variables = {
    ...(operation?.variables && typeof operation.variables === "object"
      ? operation.variables
      : {}),
    communityId,
  };
  const features = operation?.features && Object.keys(operation.features).length
    ? operation.features
    : COMMUNITY_FEATURES;
  const payload = await graphqlGet(
    operation?.documentId || DOCUMENT_IDS.CommunityQuery,
    operation?.operation || "CommunityQuery",
    variables,
    features,
    {
      ...requestOptions,
      maxAttempts: 3,
      clientTransactionId: operation?.clientTransactionId || null,
    }
  );
  return parseCommunityInfoPayload(payload);
}

// X's own Community analytics panel. Verified readable on 2026-07-30 by a
// signed-in account holding no role in the target Community, so it is a free
// source of the two totals the scanner otherwise has to guess:
// `total_members` is the authoritative coverage denominator, and
// `unique_posters` is the number of distinct authors X counted in the same
// period — the completeness target for author discovery, which previously ran
// until a cursor ended with nothing to measure itself against.
export function parseCommunityAnalyticsPayload(payload) {
  const metrics = firstKey(payload, "current_metrics").value;
  if (!metrics || typeof metrics !== "object") return null;
  const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    totalMembers: finite(metrics.total_members),
    uniquePosters: finite(metrics.unique_posters),
    newMembers: finite(metrics.new_members),
    posts: finite(metrics.num_posts),
    replies: finite(metrics.reply_count),
    favorites: finite(metrics.fav_count),
    impressions: finite(metrics.impressions),
    measuredAt: finite(metrics.timestamp),
  };
}

export async function fetchCommunityAnalytics(communityId, options = {}) {
  const { operation, ...requestOptions } = options;
  const payload = await graphqlGet(
    operation?.documentId || DOCUMENT_IDS.CommunityAnalyticsQuery,
    operation?.operation || "CommunityAnalyticsQuery",
    { communityId },
    null,
    {
      ...requestOptions,
      maxAttempts: 2,
      clientTransactionId: operation?.clientTransactionId || null,
    }
  );
  return parseCommunityAnalyticsPayload(payload);
}
