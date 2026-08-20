import { StoppedError } from "../core/errors.js";

const REQUEST_DELAY_MS = 1500;

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new StoppedError());
    }, { once: true });
  });
}

export function waitLabel(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export class AdaptiveRateLimiter {
  // `sleep` defaults to the real setTimeout-backed delay(), so every
  // existing call site (which only ever passes minDelayMs) is unaffected.
  // Tests drive real production code paths - including scans that need to
  // run in well under the ~750-1500ms this pacing imposes per request in
  // production - by passing a no-op sleep here instead of maintaining a
  // parallel reimplementation or a global "test mode" flag.
  constructor(minDelayMs = REQUEST_DELAY_MS, sleep = delay) {
    this.minDelayMs = Math.max(300, minDelayMs);
    this.delayMs = this.minDelayMs;
    this.sleep = sleep;
  }

  success() {
    this.delayMs = Math.max(this.minDelayMs, this.delayMs * 0.98);
  }

  failure(multiplier = 1.5) {
    this.delayMs = Math.min(12000, this.delayMs * multiplier);
  }

  async wait(signal) {
    await this.sleep(this.delayMs + Math.random() * this.delayMs * 0.08, signal);
  }
}
