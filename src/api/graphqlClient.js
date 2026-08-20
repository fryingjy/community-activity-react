import { StoppedError } from "../core/errors.js";
import { AdaptiveRateLimiter, delay, waitLabel } from "./rateLimiter.js";
import { QuotaManager, readRateLimitHeaders } from "./quotaManager.js";
import { OperationRegistry } from "./operationRegistry.js";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D" +
  "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

async function csrfToken() {
  const cookie = await chrome.cookies.get({ url: "https://x.com", name: "ct0" });
  if (!cookie?.value) throw new Error("Log into x.com in this Chrome profile, then retry.");
  return cookie.value;
}

export async function graphqlGet(
  documentId,
  operation,
  variables,
  features,
  {
    signal,
    requestStats,
    log,
    limiter = new AdaptiveRateLimiter(),
    maxAttempts = 6,
    clientTransactionId = null,
    // Defaults to the real setTimeout-backed delay(), so every production
    // call site is unaffected. Tests exercising retry/backoff paths (429,
    // 5xx, network errors) against a fake server inject a no-op here instead
    // of waiting out real multi-second backoffs.
    delayFn = delay,
  } = {}
) {
  const ct0 = await csrfToken();
  const params = new URLSearchParams({ variables: JSON.stringify(variables) });
  if (features) params.set("features", JSON.stringify(features));
  const url = `https://x.com/i/api/graphql/${documentId}/${operation}?${params}`;
  const quotaManager = requestStats ? new QuotaManager((requestStats.quotas ||= {})) : null;
  const operationRegistry = requestStats ? new OperationRegistry((requestStats.operations ||= {})) : null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new StoppedError();
    let response;
    const requestStartedAt = Date.now();
    try {
      response = await fetch(url, {
        credentials: "include",
        signal,
        headers: {
          authorization: `Bearer ${BEARER}`,
          "x-csrf-token": ct0,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-client-language": "en",
          ...(clientTransactionId ? { "x-client-transaction-id": clientTransactionId } : {}),
        },
      });
    } catch (error) {
      if (error.name === "AbortError") throw new StoppedError();
      if (requestStats) {
        requestStats.network ||= [];
        requestStats.network.push({
          operation,
          attempt,
          status: null,
          durationMs: Date.now() - requestStartedAt,
          outcome: "network-error",
        });
        if (requestStats.network.length > 1000) requestStats.network.shift();
      }
      limiter.failure();
      if (attempt === maxAttempts) throw new Error(`Network request failed: ${error.message}`);
      const waitMs = Math.min(20000, 1200 * 2 ** (attempt - 1));
      log?.(`Network error; retrying in ${waitLabel(waitMs)}.`);
      await delayFn(waitMs, signal);
      continue;
    }

    if (requestStats) {
      requestStats.count = (requestStats.count || 0) + 1;
      requestStats.network ||= [];
      requestStats.network.push({
        operation,
        attempt,
        status: response.status,
        durationMs: Date.now() - requestStartedAt,
        outcome: response.ok ? "response" : "http-error",
      });
      if (requestStats.network.length > 1000) requestStats.network.shift();
      const headerInfo = readRateLimitHeaders(response.headers);
      const recorded = quotaManager?.record(operation, headerInfo);
      if (recorded?.enteringWarning) {
        log?.(`${operation} has ${recorded.quota.remaining} server-reported request(s) remaining in this window.`);
        limiter.failure(1.5);
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Your x.com session cannot access this Community. Log in again and verify the Members page opens.");
    }
    if (response.status === 429) {
      limiter.failure(2);
      const resetSeconds = Number(response.headers.get("x-rate-limit-reset"));
      const retrySeconds = Number(response.headers.get("retry-after"));
      const waitMs = Math.min(
        15 * 60 * 1000,
        Math.max(
          Number.isFinite(resetSeconds) ? resetSeconds * 1000 - Date.now() : 0,
          Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0,
          4000 * 2 ** (attempt - 1)
        ) + 1000
      );
      if (attempt === maxAttempts) {
        const error = new Error(`X rate limit remained active after ${maxAttempts} attempts.`);
        error.code = "rate-limited";
        throw error;
      }
      log?.(`X rate limit reached; waiting ${waitLabel(waitMs)}.`);
      await delayFn(waitMs, signal);
      continue;
    }
    if (response.status >= 500) {
      limiter.failure();
      if (attempt === maxAttempts) throw new Error(`X request failed (${response.status}).`);
      await delayFn(Math.min(20000, 1200 * 2 ** (attempt - 1)), signal);
      continue;
    }
    if (!response.ok) {
      operationRegistry?.recordContractFailure(operation, `http-${response.status}`);
      throw new Error(`X request failed (${response.status} ${response.statusText}).`);
    }

    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error(`X returned an unreadable response for ${operation}.`);
    if (payload.errors?.length && !payload.data) {
      operationRegistry?.recordContractFailure(operation, "graphql-error");
      throw new Error(payload.errors.map((item) => item?.message || "X GraphQL error").join("; "));
    }
    operationRegistry?.recordSuccess(operation);
    limiter.success();
    await limiter.wait(signal);
    return payload;
  }
  throw new Error(`X did not complete ${operation} after ${maxAttempts} attempts.`);
}
