/** Types for stamp-version.mjs, so its test can import it. */
export function parseVersion(raw: string | undefined): string;
export function releaseVersion(env?: Record<string, string | undefined>): string;
