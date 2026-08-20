import test from "node:test";
import assert from "node:assert/strict";
import { ScanCoordinator } from "../src/core/scanCoordinator.js";

test("ScanCoordinator runs steps in order against the shared ctx", async () => {
  const order = [];
  const coordinator = new ScanCoordinator([
    { name: "a", run: async (ctx) => { order.push("a"); ctx.a = true; } },
    { name: "b", run: async (ctx) => { order.push("b"); ctx.b = ctx.a; } },
  ]);
  const ctx = {};
  await coordinator.run(ctx);
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(ctx.b, true);
});

test("ScanCoordinator stops at the first step that throws and does not run later steps", async () => {
  const ran = [];
  const failure = new Error("boom");
  const coordinator = new ScanCoordinator([
    { name: "a", run: async () => { ran.push("a"); } },
    { name: "b", run: async () => { ran.push("b"); throw failure; } },
    { name: "c", run: async () => { ran.push("c"); } },
  ]);
  await assert.rejects(() => coordinator.run({}), failure);
  assert.deepEqual(ran, ["a", "b"]);
});

test("ScanCoordinator reports each step's name, duration, and outcome via onStepStart/onStepEnd", async () => {
  const starts = [];
  const ends = [];
  const coordinator = new ScanCoordinator([
    { name: "ok-step", run: async () => {} },
    { name: "failing-step", run: async () => { throw new Error("nope"); } },
  ]);
  await assert.rejects(() =>
    coordinator.run({}, {
      onStepStart: (name) => starts.push(name),
      onStepEnd: (name, _ctx, { durationMs, error }) => ends.push({ name, hasDuration: durationMs >= 0, failed: !!error }),
    })
  );
  assert.deepEqual(starts, ["ok-step", "failing-step"]);
  assert.deepEqual(ends, [
    { name: "ok-step", hasDuration: true, failed: false },
    { name: "failing-step", hasDuration: true, failed: true },
  ]);
});
