/** A counter is allocated atomically in Mongo; codes are never recycled after cancellation. */
export function listingCodeFromSequence(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid listing sequence');
  if (sequence <= 900_000) return String(sequence + 99_999);
  const offset = sequence - 900_001;
  const block = 36 ** 5;
  if (offset >= 26 * block) throw new Error('Listing code space exhausted');
  return String.fromCharCode(65 + Math.floor(offset / block)) + (offset % block).toString(36).toUpperCase().padStart(5, '0');
}

export function parseListingCode(text: string): string | null {
  const normalized = text.trim().replace(/^\/id(?:@[a-z\d_]+)?\s+/i, '').replace(/^#/, '').toUpperCase();
  return /^(?:[1-9]\d{5}|[A-Z][A-Z\d]{5})$/.test(normalized) ? normalized : null;
}
