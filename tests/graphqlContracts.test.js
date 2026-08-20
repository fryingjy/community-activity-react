import test from "node:test";
import assert from "node:assert/strict";
import {
  GraphqlContractError,
  parseCommunityInfoPayload,
  requireCommunityTimeline,
} from "../graphqlContracts.js";

test("Community metadata parser accepts the documented internal shape", () => {
  const result = parseCommunityInfoPayload({ data: { communityResults: { result: {
    __typename: "Community", name: "Builders", member_count: 42, description: "A community",
  } } } });
  assert.deepEqual(result, { name: "Builders", memberCount: 42, description: "A community" });
});

test("timeline contract returns the timeline object", () => {
  const timeline = { instructions: [] };
  assert.equal(requireCommunityTimeline({ data: { communityResults: { result: { ranked_community_timeline: { timeline } } } } }), timeline);
});

test("timeline contract supports independent media and search surfaces", () => {
  const media = { instructions: [{ entries: [] }] };
  const search = { instructions: [{ entries: [] }] };
  const payload = {
    data: {
      communityResults: {
        result: {
          community_media_timeline: { timeline: media },
          community_filtered_timeline: { timeline: search },
        },
      },
    },
  };
  assert.equal(requireCommunityTimeline(payload, "media"), media);
  assert.equal(requireCommunityTimeline(payload, "search"), search);
});

test("timeline contract reports rotated operation shapes", () => {
  assert.throws(() => requireCommunityTimeline({ data: {} }), GraphqlContractError);
});
