/**
 * The canonical IANA name of a timezone, e.g. "europe/berlin" -> "Europe/Berlin", or null when
 * the runtime does not know it. Abbreviations such as "CEST" are not zone names and return null.
 */
export function canonicalTimeZone(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || /^[A-Z]{2,5}$/.test(trimmed) && trimmed !== "UTC") return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
