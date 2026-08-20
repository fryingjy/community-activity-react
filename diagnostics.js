import { summarizeScanCompleteness, determineActionability } from "./src/core/scanCompleteness.js";

const SECRET_ASSIGNMENT =
  /\b(authorization|cookie|set-cookie|x-csrf-token|csrf|ct0|auth_token|password|bearer)\b\s*[:=]\s*[^\s,;]+/gi;
const URL_WITH_QUERY = /https?:\/\/[^\s]+/gi;
const OPAQUE_VALUE = /\b[A-Za-z0-9_\-+/=]{96,}\b/g;
const USERNAME = /@[A-Za-z0-9_]{1,15}\b/g;

export function redactDiagnosticText(value) {
  return String(value || "")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(URL_WITH_QUERY, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url removed]";
      }
    })
    .replace(OPAQUE_VALUE, "[opaque value removed]")
    .replace(USERNAME, "@user")
    .slice(0, 1000);
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function summarizeNetwork(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    const operation = redactDiagnosticText(entry?.operation) || "unknown";
    const group = groups.get(operation) || {
      operation,
      count: 0,
      durations: [],
      statuses: {},
      outcomes: {},
      retries: 0,
    };
    group.count++;
    if (Number.isFinite(entry?.durationMs)) group.durations.push(entry.durationMs);
    const status = Number.isFinite(entry?.status) ? String(entry.status) : "network";
    group.statuses[status] = (group.statuses[status] || 0) + 1;
    const outcome = redactDiagnosticText(entry?.outcome) || "unknown";
    group.outcomes[outcome] = (group.outcomes[outcome] || 0) + 1;
    if (Number.isFinite(entry?.attempt) && entry.attempt > 1) group.retries++;
    groups.set(operation, group);
  }
  return [...groups.values()].map((group) => {
    const totalDuration = group.durations.reduce((sum, value) => sum + value, 0);
    return {
      operation: group.operation,
      count: group.count,
      statuses: group.statuses,
      outcomes: group.outcomes,
      retries: group.retries,
      averageDurationMs: group.durations.length
        ? Math.round(totalDuration / group.durations.length)
        : null,
      p50DurationMs: percentile(group.durations, 0.5),
      p95DurationMs: percentile(group.durations, 0.95),
      maximumDurationMs: group.durations.length
        ? Math.max(...group.durations)
        : null,
    };
  });
}

function summarizeRosterPages(entries) {
  const pages = (entries || []).filter((entry) => Number.isFinite(entry?.page));
  if (!pages.length) return null;
  const additions = pages
    .map((entry) => entry?.added)
    .filter(Number.isFinite);
  const last = pages.at(-1);
  return {
    recordedPages: pages.length,
    firstPage: pages[0].page,
    lastPage: last.page,
    firstTotal: finiteOrNull(pages[0].total),
    lastTotal: finiteOrNull(last.total),
    averageAdded: additions.length
      ? Number((additions.reduce((sum, value) => sum + value, 0) / additions.length).toFixed(2))
      : null,
    minimumAdded: additions.length ? Math.min(...additions) : null,
    maximumAdded: additions.length ? Math.max(...additions) : null,
    zeroAdditionPages: additions.filter((value) => value === 0).length,
    terminalCursorPresent: last.hasNextCursor === true,
  };
}

function safeRoster(roster) {
  if (!roster || typeof roster !== "object") return null;
  return {
    complete: roster.complete === true,
    found: finiteOrNull(roster.found),
    expected: finiteOrNull(roster.expected),
    reason: redactDiagnosticText(roster.reason),
  };
}

function safeActivity(activity) {
  if (!activity || typeof activity !== "object") return null;
  return {
    complete: activity.complete === true,
    backfillComplete: activity.backfillComplete === true,
    reason: redactDiagnosticText(activity.reason),
  };
}

function safeTimelineArchive(archive) {
  if (!archive || typeof archive !== "object") return null;
  return {
    pages: finiteOrNull(archive.pages),
    scannedPosts: finiteOrNull(archive.scannedPosts),
    authors: finiteOrNull(archive.authors),
    oldestPostAt: archive.oldestPostAt
      ? redactDiagnosticText(archive.oldestPostAt)
      : null,
    complete: archive.complete === true,
    reason: redactDiagnosticText(archive.reason),
    error: redactDiagnosticText(archive.error),
  };
}

function safeDiagnostics(diagnostics) {
  const value = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const network = value.network || [];
  const rosterPages = value.rosterPages || [];
  return {
    requestCount: finiteOrNull(value.count) || 0,
    // Which of X's persisted operations this scan actually confirmed still
    // work, versus one that came back with a definitive rejection (a stale
    // document ID, a removed feature switch) - not a preflight probe, just
    // what real scan traffic already showed.
    operations: Object.fromEntries(
      Object.entries(value.operations || {}).slice(0, 20).map(([operation, state]) => [
        redactDiagnosticText(operation),
        {
          status: state?.status === "ok" || state?.status === "broken" ? state.status : "unknown",
          reason: redactDiagnosticText(state?.reason),
          checkedAt: finiteOrNull(state?.checkedAt),
        },
      ])
    ),
    quotas: Object.fromEntries(
      Object.entries(value.quotas || {}).slice(0, 20).map(([operation, quota]) => [
        redactDiagnosticText(operation),
        {
          limit: finiteOrNull(quota?.limit),
          remaining: finiteOrNull(quota?.remaining),
          resetAt: finiteOrNull(quota?.resetAt),
          resetAtIso: Number.isFinite(quota?.resetAt)
            ? new Date(quota.resetAt).toISOString()
            : null,
        },
      ])
    ),
    networkSummary: summarizeNetwork(network),
    network: network.slice(-25).map((entry) => ({
      operation: redactDiagnosticText(entry?.operation),
      attempt: finiteOrNull(entry?.attempt),
      status: finiteOrNull(entry?.status),
      durationMs: finiteOrNull(entry?.durationMs),
      outcome: redactDiagnosticText(entry?.outcome),
    })),
    rosterOperation: value.rosterOperation
      ? {
          name: redactDiagnosticText(value.rosterOperation.name),
          documentId: redactDiagnosticText(value.rosterOperation.documentId),
          variableKeys: (value.rosterOperation.variableKeys || []).map(redactDiagnosticText),
          featureCount: finiteOrNull(value.rosterOperation.featureCount),
          transactionHeaderPresent: value.rosterOperation.transactionHeaderPresent === true,
        }
      : null,
    nativeRosterOperation: value.nativeRosterOperation
      ? {
          name: redactDiagnosticText(value.nativeRosterOperation.name),
          documentId: redactDiagnosticText(value.nativeRosterOperation.documentId),
          returned: finiteOrNull(value.nativeRosterOperation.returned),
          complete: value.nativeRosterOperation.complete === true,
          reason: redactDiagnosticText(value.nativeRosterOperation.reason),
          reachedTerminalCursor:
            value.nativeRosterOperation.reachedTerminalCursor === true,
          segments: finiteOrNull(value.nativeRosterOperation.segments),
          reseeks: finiteOrNull(value.nativeRosterOperation.reseeks),
          error: redactDiagnosticText(value.nativeRosterOperation.error),
        }
      : null,
    webCursorSkipped: value.webCursorSkipped
      ? {
          reason: redactDiagnosticText(value.webCursorSkipped.reason),
          nativeMembers: finiteOrNull(value.webCursorSkipped.nativeMembers),
        }
      : null,
    moderatorSlice: value.moderatorSlice
      ? {
          returned: finiteOrNull(value.moderatorSlice.returned),
          added: finiteOrNull(value.moderatorSlice.added),
        }
      : null,
    // Aggregate counts only: no usernames, post text, or per-member records.
    analytics: value.analytics
      ? {
          totalMembers: finiteOrNull(value.analytics.totalMembers),
          uniquePosters: finiteOrNull(value.analytics.uniquePosters),
          newMembers: finiteOrNull(value.analytics.newMembers),
          posts: finiteOrNull(value.analytics.posts),
          measuredAt: finiteOrNull(value.analytics.measuredAt),
        }
      : null,
    authorCoverage: value.authorCoverage
      ? {
          observed: finiteOrNull(value.authorCoverage.observed),
          reportedUniquePosters: finiteOrNull(
            value.authorCoverage.reportedUniquePosters
          ),
        }
      : null,
    // Aggregate counts only: which flagged members were confirmed and how many
    // were cleared, never usernames or search results.
    activitySearchVerification: value.activitySearchVerification
      ? {
          checked: finiteOrNull(value.activitySearchVerification.checked),
          queued: finiteOrNull(value.activitySearchVerification.queued),
          remaining: finiteOrNull(value.activitySearchVerification.remaining),
          cleared: finiteOrNull(value.activitySearchVerification.cleared),
          reason: redactDiagnosticText(value.activitySearchVerification.reason),
        }
      : null,
    activityOperation: value.activityOperation
      ? {
          name: redactDiagnosticText(value.activityOperation.name),
          documentIdLength: finiteOrNull(value.activityOperation.documentIdLength),
          variableKeys: (value.activityOperation.variableKeys || []).map(redactDiagnosticText),
          featureCount: finiteOrNull(value.activityOperation.featureCount),
          transactionHeaderPresent:
            value.activityOperation.transactionHeaderPresent === true,
        }
      : null,
    communityOperation: value.communityOperation
      ? {
          name: redactDiagnosticText(value.communityOperation.name),
          documentIdLength: finiteOrNull(value.communityOperation.documentIdLength),
          variableKeys: (value.communityOperation.variableKeys || []).map(redactDiagnosticText),
          featureCount: finiteOrNull(value.communityOperation.featureCount),
        }
      : null,
    rosterSummary: summarizeRosterPages(rosterPages),
    rosterPages: rosterPages.slice(-20).map((entry) => ({
      source: redactDiagnosticText(entry?.source),
      page: finiteOrNull(entry?.page),
      total: finiteOrNull(entry?.total),
      added: finiteOrNull(entry?.added),
      hasNextCursor: entry?.hasNextCursor === true,
    })),
    dom: value.dom
      ? {
          mode: redactDiagnosticText(value.dom.mode),
          updates: finiteOrNull(value.dom.updates),
          lastCount: finiteOrNull(value.dom.lastCount),
          complete: value.dom.complete === true,
          reason: redactDiagnosticText(value.dom.reason),
          passes: finiteOrNull(value.dom.passes),
        }
      : null,
    activity: value.activity
      ? {
          pages: finiteOrNull(value.activity.pages),
          scannedPosts: finiteOrNull(value.activity.scannedPosts),
          activeAuthors: finiteOrNull(value.activity.activeAuthors),
          observedAuthors: finiteOrNull(value.activity.observedAuthors),
          windowComplete:
            value.activity.windowComplete === true ||
            value.activity.complete === true,
          backfillComplete:
            value.activity.backfillComplete === true,
        }
      : null,
    timelineBackfill: safeTimelineArchive(value.timelineBackfill),
    mediaBackfill: safeTimelineArchive(value.mediaBackfill),
    searchBackfill: value.searchBackfill
      ? {
          authors: finiteOrNull(value.searchBackfill.authors),
          complete: value.searchBackfill.complete === true,
          shardCount:
            finiteOrNull(value.searchBackfill.shardCount) ??
            (Array.isArray(value.searchBackfill.shards)
              ? value.searchBackfill.shards.length
              : null),
          completedShards:
            finiteOrNull(value.searchBackfill.completedShards) ??
            (Array.isArray(value.searchBackfill.shards)
              ? value.searchBackfill.shards.filter((shard) => shard?.complete === true).length
              : null),
          error: redactDiagnosticText(value.searchBackfill.error),
        }
      : null,
    membershipVerification: value.membershipVerification
      ? {
          checked: finiteOrNull(value.membershipVerification.checked),
          queued: finiteOrNull(value.membershipVerification.queued),
          confirmed: finiteOrNull(value.membershipVerification.confirmed),
          additions: finiteOrNull(value.membershipVerification.additions),
          reason: redactDiagnosticText(value.membershipVerification.reason),
        }
      : null,
    // How long each top-level scan stage took, in the order it ran. Step
    // names are our own fixed identifiers (see sidepanel.js's SCAN_STEPS),
    // never response data, but still passed through redactDiagnosticText for
    // uniform handling.
    steps: (value.steps || []).slice(0, 50).map((step) => {
      // "status" is only present on job records saved after the
      // running/complete/failed distinction was added; a record saved
      // before that always finished by the time it was recorded (onStepEnd
      // only ever appended), so it infers as "complete"/"failed" rather
      // than the now-possible "running".
      const status = ["running", "complete", "failed"].includes(step?.status)
        ? step.status
        : step?.ok === false ? "failed" : "complete";
      return {
        name: redactDiagnosticText(step?.name),
        durationMs: finiteOrNull(step?.durationMs),
        ok: status !== "failed",
        status,
      };
    }),
  };
}

export function buildDiagnosticReport({
  manifest,
  userAgent,
  language,
  job,
  settings,
  events,
  tab,
  page,
}) {
  return {
    report: "Community Activity diagnostics",
    schema: 3,
    generatedAt: new Date().toISOString(),
    privacy:
      "Sanitized metadata only. No cookies, authorization headers, tokens, usernames, member records, or response bodies.",
    extension: {
      name: String(manifest?.name || "Community Activity"),
      version: String(manifest?.version || ""),
      manifestVersion: finiteOrNull(manifest?.manifest_version),
    },
    environment: {
      userAgent: redactDiagnosticText(userAgent),
      language: String(language || ""),
    },
    settings: {
      communityId: String(job?.communityId || settings?.communityId || ""),
      lookbackDays: finiteOrNull(settings?.lookbackDays),
      inactivityRule:
        settings?.inactivityRule === "zero-community-posts-or-replies"
          ? settings.inactivityRule
          : "zero-community-posts-or-replies",
      timelineBackfill: settings?.timelineBackfill === true,
      focusLock: settings?.focusLock === true,
    },
    scan: {
      status: redactDiagnosticText(job?.status),
      phase: redactDiagnosticText(job?.phase),
      expectedMembers: finiteOrNull(job?.expectedMembers),
      roster: safeRoster(job?.roster),
      activity: safeActivity(job?.activity),
      // One canonical "can this output be trusted" answer, derived from the
      // same roster/activity/verification signals above rather than left for
      // a reader to reconstruct from them independently.
      completeness: (() => {
        const summary = summarizeScanCompleteness({
          roster: job?.roster,
          activity: job?.activity,
          verification: job?.diagnostics?.activitySearchVerification,
        });
        return { ...summary, ...determineActionability(summary) };
      })(),
      requestCount:
        finiteOrNull(job?.requests) ??
        finiteOrNull(job?.diagnostics?.count) ??
        0,
      flaggedCount: Array.isArray(job?.results)
        ? job.results.length
        : finiteOrNull(job?.flagged),
      privateCount: Array.isArray(job?.privateAccounts)
        ? job.privateAccounts.length
        : null,
      error: redactDiagnosticText(job?.error),
      updatedAt: finiteOrNull(job?.updatedAt),
    },
    diagnostics: safeDiagnostics(job?.diagnostics),
    browserTab: {
      active: tab?.active === true,
      discarded: tab?.discarded === true,
      frozen: tab?.frozen === true,
      autoDiscardable: tab?.autoDiscardable !== false,
      status: redactDiagnosticText(tab?.status),
      windowFocused: tab?.windowFocused === true,
      windowState: redactDiagnosticText(tab?.windowState),
    },
    page: page
      ? {
          visibilityState: redactDiagnosticText(page.visibilityState),
          hidden: page.hidden === true,
          focused: page.focused === true,
          renderedMemberRows: finiteOrNull(page.renderedMemberRows),
          renderedNonRosterUserRows: finiteOrNull(page.renderedNonRosterUserRows),
          primaryColumnPresent: page.primaryColumnPresent === true,
          viewportHeight: finiteOrNull(page.viewportHeight),
          scrollTop: finiteOrNull(page.scrollTop),
          scrollHeight: finiteOrNull(page.scrollHeight),
        }
      : null,
    events: (events || []).slice(-80).map((entry) => ({
      time: redactDiagnosticText(entry?.time),
      level: redactDiagnosticText(entry?.level),
      message: redactDiagnosticText(entry?.message),
    })),
  };
}
