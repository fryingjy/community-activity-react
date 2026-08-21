// X announced Communities would shut down by 2026-05-30; that deadline
// passed with the feature still active and no further word from X since.
// Nothing on X's own Community pages carries this warning - see
// ENDPOINT_AUDIT.md's 2026-08-20 live re-verification - so this extension
// states it explicitly rather than let a sudden platform removal read as an
// unexplained bug in the scanner.
export function PlatformStatusNotice() {
  return (
    <p className="notice caution">
      <i className="glyph" aria-hidden="true">!</i>
      <span>
        X announced Communities would shut down by 2026-05-30; that deadline passed with
        the feature still active and no further word from X since. If a Community that
        scanned successfully before suddenly fails on every request, X may have removed
        it — nothing here can detect or prevent that in advance.
      </span>
    </p>
  );
}
