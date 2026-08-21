const TIER_COPY = {
  "confirmed-inactive": {
    label: "Confirmed inactive",
    tone: "success",
    detail: "A direct (from:username) search found zero posts or replies in the window - this row is safe to act on.",
  },
  unverified: {
    label: "Unverified",
    tone: "warning",
    detail: "Rests on the broad crawl alone; a direct search hasn't checked this one yet (or hasn't reached it this run). Review manually before acting.",
  },
  "unverifiable-protected": {
    label: "Unverifiable (protected account)",
    tone: "muted",
    detail: "A protected account returns the same empty search result whether it genuinely posted nothing or is simply invisible to this session - this is not the same evidence as a confirmed public account.",
  },
};

export function MemberInspector({ member, onClose }) {
  if (!member) return null;
  const tier = TIER_COPY[member.activityVerification] || TIER_COPY.unverified;
  return (
    <aside className="inspector" aria-label={`Evidence for @${member.username}`}>
      <div className="inspector-head">
        <div>
          <span className="kicker">Evidence</span>
          <h3>@{member.username}</h3>
        </div>
        <button type="button" className="secondary" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <span className={`tier-pill tone-${tier.tone}`}>{tier.label}</span>
      <p className="inspector-note">{tier.detail}</p>

      <dl className="inspector-facts">
        <div>
          <dt>Role</dt>
          <dd>{member.role || "Member"}</dd>
        </div>
        <div>
          <dt>Posts in window</dt>
          <dd className="tabular">{member.communityPostsInWindow || 0}</dd>
        </div>
        <div>
          <dt>Replies in window</dt>
          <dd className="tabular">{member.communityRepliesInWindow || 0}</dd>
        </div>
        <div>
          <dt>Roster evidence</dt>
          <dd>{member.membershipEvidence || "x-roster"}</dd>
        </div>
        <div>
          <dt>Protected account</dt>
          <dd>{member.protected ? "Yes" : "No"}</dd>
        </div>
        {member.lastSeenCommunityPost && (
          <div>
            <dt>Last seen posting</dt>
            <dd>{new Date(member.lastSeenCommunityPost).toLocaleDateString()}</dd>
          </div>
        )}
      </dl>

      <div className="inspector-reason">
        <span className="kicker">Flag reason</span>
        <p>{member.flagReason}</p>
      </div>
    </aside>
  );
}
