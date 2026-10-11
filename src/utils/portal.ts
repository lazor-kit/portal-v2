/** The host the device names in its passkey prompt: this portal's own (portal.lazor.sh in production). */
export function portalHost(): string {
  return window.location.host
}

/** "LazorKit · Oct 7, 2026": what the device lists a new passkey as, unless the person renames it. */
export function defaultPasskeyName(now = new Date()): string {
  return `LazorKit · ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
}
