/**
 * When to tell the reader a newer version exists. Pure, so it can be tested without a browser.
 *
 * Two independent signals feed the prompt (see appUpdate.ts): a waiting service worker, and the site's own version.json (written at
 * build time with the same build id the running app was built with). The second one does not depend on a service worker being active,
 * so a hard refresh, a browser that is not letting the worker control the page, or a worker that failed to update cannot hide an update.
 */
export function shouldPrompt(o: { appBuild: string; remoteBuild: string | null; dismissed: string; manual: boolean }): boolean {
  const { appBuild, remoteBuild, dismissed, manual } = o;
  if (!remoteBuild || appBuild === 'dev') return false; // nothing to compare with / running a dev server
  if (remoteBuild === appBuild) return false; // same code: a redeploy of unchanged files never bothers anyone
  return manual || remoteBuild !== dismissed; // "Later" is remembered for that build, but "Check for updates" always answers
}

/** Reads the build id out of version.json's content. Anything that is not a short id string is ignored. */
export function parseVersion(data: unknown): string | null {
  const b = (data as { build?: unknown } | null)?.build;
  return typeof b === 'string' && /^[a-z0-9-]{4,40}$/i.test(b) ? b : null;
}
