import { useEffect, useRef, useState } from "react";

// A continuously-chasing tween, not a replay-from-zero one: it eases from
// whatever is currently displayed toward the latest target, so a value that
// updates again mid-animation (a live scan's counters can update many times
// a second) smoothly changes direction instead of resetting and restarting.
// Returns the raw eased number - callers format/round it themselves, the
// same way they already format the underlying state value.
export function useCountUp(target, duration = 700) {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!Number.isFinite(target)) {
      setDisplay(target);
      return;
    }
    const from = display;
    if (from === target) return;
    let start = null;
    function tick(now) {
      if (start == null) start = now;
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (target - from) * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    }
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
    // Deliberately excludes `display`: re-running this effect every tick
    // would fight its own animation. `from` is read once per target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return Number.isFinite(target) ? display : target;
}
