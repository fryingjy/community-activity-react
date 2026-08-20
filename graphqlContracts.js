export class GraphqlContractError extends Error {
  constructor(operation, path) {
    super(`Unexpected GraphQL response shape for ${operation}; missing ${path}. X may have rotated the operation document ID.`);
    this.name = "GraphqlContractError";
    this.operation = operation;
    this.path = path;
  }
}

export function parseCommunityInfoPayload(payload) {
  const result = payload?.data?.communityResults?.result;
  if (!result || result.__typename !== "Community") return null;
  return {
    name: result.name || null,
    memberCount: typeof result.member_count === "number" ? result.member_count : null,
    description: result.description || null,
  };
}

export function requireCommunityTimeline(payload, kind = "activity") {
  const result = payload?.data?.communityResults?.result;
  const contracts = {
    activity: {
      operation: "CommunityTweetsTimeline",
      path: "data.communityResults.result.ranked_community_timeline.timeline",
      timeline: result?.ranked_community_timeline?.timeline,
    },
    media: {
      operation: "CommunityMediaTimeline",
      path: "data.communityResults.result.community_media_timeline.timeline",
      timeline: result?.community_media_timeline?.timeline,
    },
    search: {
      operation: "CommunityTweetSearchModuleQuery",
      path: "data.communityResults.result.community_filtered_timeline.timeline",
      timeline: result?.community_filtered_timeline?.timeline,
    },
  };
  const contract = contracts[kind] || contracts.activity;
  const timeline = contract.timeline;
  if (!timeline) throw new GraphqlContractError(contract.operation, contract.path);
  return timeline;
}
