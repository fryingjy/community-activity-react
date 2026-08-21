// A small matching line-icon set, drawn to sit alongside the brand mark's
// own hand-drawn SVG (see AppShell.jsx) instead of leaning on Unicode
// glyphs, which render however the OS happens to font them - not something
// a "designed" instrument panel should leave to chance. Every icon shares
// the brand mark's treatment (stroke=currentColor, no fill, round caps),
// applied once in theme.css rather than repeated per icon here.

export function OverviewIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M2.5 14 8 8.2l4 4 5.3-6.4L21.5 10" />
      <circle cx="8" cy="8.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.3" cy="5.8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6" />
    </svg>
  );
}

export function FlagIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M6 2.5v19" />
      <path d="M6 4h11.5l-3.2 4 3.2 4H6" />
    </svg>
  );
}

export function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 2.6 19 5.4v5.7c0 5-3 8.3-7 9.9-4-1.6-7-4.9-7-9.9V5.4L12 2.6z" />
      <path d="M8.6 12.2l2.3 2.3 4.5-4.5" />
    </svg>
  );
}

export function StorageIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <ellipse cx="12" cy="5.5" rx="7.2" ry="2.6" />
      <path d="M4.8 5.5v6.2c0 1.4 3.2 2.6 7.2 2.6s7.2-1.2 7.2-2.6V5.5" />
      <path d="M4.8 11.7v6.2c0 1.4 3.2 2.6 7.2 2.6s7.2-1.2 7.2-2.6v-6.2" />
    </svg>
  );
}

// A quiet "sensor sweep" hero for the empty overview state - static rings
// and crosshair drawn once in SVG, the rotating beam and blip pulses done
// as separate CSS layers (see theme.css's .radar-* rules) so the motion
// itself costs nothing more than a transform/opacity animation.
export function RadarSweep() {
  return (
    <div className="radar-hero" aria-hidden="true">
      <div className="radar-sweep" />
      <svg viewBox="0 0 160 160">
        <circle className="radar-ring" cx="80" cy="80" r="70" />
        <circle className="radar-ring" cx="80" cy="80" r="48" />
        <circle className="radar-ring" cx="80" cy="80" r="26" />
        <line className="radar-axis" x1="6" y1="80" x2="154" y2="80" />
        <line className="radar-axis" x1="80" y1="6" x2="80" y2="154" />
        <circle className="radar-blip radar-blip-a" cx="114" cy="52" r="2.6" />
        <circle className="radar-blip radar-blip-b" cx="55" cy="106" r="2.6" />
        <circle className="radar-blip radar-blip-c" cx="120" cy="110" r="2.2" />
        <circle className="radar-core" cx="80" cy="80" r="4" />
      </svg>
    </div>
  );
}
