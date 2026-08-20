export const NATIVE_ROSTER_FALLBACK_COUNT = 100;

// Live-verified 2026-08-20 against the "NMS HUB" reference Community
// (1882332006949744648) via a real signed-in session, cross-checked against
// the 2026-07-27 audit in ENDPOINT_AUDIT.md. `CommunityQuery` matched; the two
// below had rotated since the audit. `CommunityAboutTimeline` has no live
// DOM-discovery fallback (see aboutMembers.js and the absence of any
// discoverCommunityAboutOperation), so a stale value here silently breaks the
// About-surface member/moderator evidence source on every scan, not just a
// worst-case one - confirmed broken before this fix, not just theoretically
// exposed. `CommunityTweetsTimeline` is normally overridden by
// discoverCommunityTimelineOperation's live discovery (domScan.js), so its
// entry here only matters when that discovery itself fails; updated anyway so
// the fallback is a real value rather than a known-stale one.
export const DOCUMENT_IDS = Object.freeze({
  CommunityQuery: "-ElI1vg3dYbttVMhBhGdLw",
  CommunityTweetsTimeline: "EwftYyqQemkckQ0wzGM6uw",
  CommunityMediaTimeline: "9MUOEALCr46-4atDb2nq1A",
  CommunityAboutTimeline: "H-QOvucTlztqr3leGYpg7g",
  CommunityTweetSearchModuleQuery: "00kKs1lbMvTB7qWooua0rQ",
  CommunityAnalyticsQuery: "WjkcJu3u0ICw288PAUaPOQ",
  moderatorsSliceTimeline_Query: "0oYT9GRiWUhrz5xoqFE9uw",
});

// Extracted from the signed X Android 12.11.0-release.0 operation registry
// (2026-07-24). X may retire or server-cap this persisted operation, so callers
// must retain the live web-query and DOM fallbacks.
//
// A 2026-07-30 signed-in walk to termination measured this route reaching
// 46,960 unique members over 501 pages on a 79,397-member Community — about
// five times the roughly 9,300 records the web `membersSliceTimeline_Query`
// cursor returns. It is the primary roster source, not an experiment.
//
// `count` is capped at 100 server-side without an error: a request for 200
// still returns 100 records, so the larger request only misreports the page
// size in diagnostics. The downgrade path below is retained in case X starts
// rejecting oversized pages outright instead of silently clamping them.
export const NATIVE_MEMBERS_ALL_OPERATION = Object.freeze({
  documentId: "mq7ptH6j5ApwD9VEGR46sg",
  operation: "CommunitiesMembersAllQuery",
  communityVariable: "community_rest_id",
  cursorVariable: "cursor",
  variables: Object.freeze({ count: NATIVE_ROSTER_FALLBACK_COUNT }),
  features: Object.freeze({
    grok_translations_timeline_user_bio_auto_translation_is_enabled: false,
    unified_cards_ad_metadata_container_dynamic_card_content_query_enabled: false,
    android_ad_formats_media_component_render_overlay_enabled: false,
    unified_cards_destination_url_params_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    immersive_video_status_linkable_timestamps: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    blue_business_profile_image_shape_enabled: true,
    super_follow_user_api_enabled: false,
    super_follow_badge_privacy_enabled: false,
    super_follow_exclusive_tweet_notifications_enabled: false,
    profile_label_improvements_pcf_label_in_profile_enabled: true,
    subscriptions_verification_info_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    premium_content_api_read_enabled: false,
    super_follow_tweet_api_enabled: false,
    longform_notetweets_consumption_enabled: true,
    articles_api_enabled: true,
    grok_android_analyze_trend_fetch_enabled: false,
    android_quick_promote_analytics_banner_enabled: false,
    grok_translations_post_auto_translation_is_enabled: false,
    grok_translations_community_note_auto_translation_is_enabled: false,
    grok_translations_community_note_translation_is_enabled: false,
    android_graphql_skip_api_media_color_palette: false,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
  }),
});

export const MEMBER_RELATIONSHIP_OPERATION = Object.freeze({
  documentId: "6YgvBKI7c3YZ9d7zKKojng",
  operation: "CommunityMemberRelationshipTypeahead",
});

export const COMMUNITY_FEATURES = {
  c9s_list_members_action_api_enabled: false,
  c9s_superc9s_indication_enabled: false,
};

// Persisted X queries reject requests when feature variables referenced by the
// current operation are missing. The live Latest, Media, About, and Community
// search operations currently share this 38-switch contract.
export const TIMELINE_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};
