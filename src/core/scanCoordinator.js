// A scan is a fixed sequence of named async steps run against one mutable
// ctx object — that sequence used to be nine bare `await stepFn(ctx)` calls
// in a row with no structure around them: no record of how long each step
// took, no single place that knew the step list itself, nothing to hook a
// future "resume from stage N" onto. ScanCoordinator turns that sequence
// into an explicit, inspectable, and testable list.
//
// It deliberately does NOT own UI phase text, DOM updates, or Stopped/Error
// classification — those still belong to each step and to the caller's
// try/catch, exactly as before. This is only the outer sequencing, made
// observable.

export class ScanCoordinator {
  constructor(steps) {
    this.steps = steps;
  }

  async run(ctx, { onStepStart, onStepEnd } = {}) {
    for (const step of this.steps) {
      onStepStart?.(step.name, ctx);
      const startedAt = Date.now();
      let error = null;
      try {
        await step.run(ctx);
      } catch (thrown) {
        error = thrown;
        throw thrown;
      } finally {
        onStepEnd?.(step.name, ctx, { durationMs: Date.now() - startedAt, error });
      }
    }
  }
}
