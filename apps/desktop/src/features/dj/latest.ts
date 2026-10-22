/**
 * Several slow checks can be in flight when the thing being checked changes.
 * `begin()` returns a function that says whether this check is still the
 * newest, so an old answer can't overwrite a newer one.
 */
export function latestOnly() {
  let newest = 0;
  return {
    begin(): () => boolean {
      const mine = ++newest;
      return () => mine === newest;
    },
    /** Make every check that is already running stale. */
    cancel(): void {
      newest++;
    },
  };
}
