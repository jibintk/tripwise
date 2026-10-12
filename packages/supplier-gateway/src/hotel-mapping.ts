/**
 * Hotel content mapping: decides when two supplier listings are the same physical property.
 * Same city is required. Then either the normalised names are equal, or the properties are within
 * 150 m of each other and share at least half of their name words.
 * Ambiguous cases stay unmapped (a duplicate in results is better than merging two hotels).
 */

const STOPWORDS = new Set(['hotel', 'hotels', 'the', 'and', 'by', 'a', 'an', 'of', '&']);

export interface MappableHotel {
  name: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface MasterHotel extends MappableHotel {
  id: string;
}

export function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
}

export function normalisedName(name: string): string {
  return nameTokens(name).join(' ');
}

/** Great-circle distance in metres. */
export function distanceMetres(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

export function isSameHotel(a: MappableHotel, b: MappableHotel): boolean {
  if (a.city.toUpperCase() !== b.city.toUpperCase()) return false;
  const na = nameTokens(a.name);
  const nb = nameTokens(b.name);
  if (na.join(' ') === nb.join(' ')) return true;
  return distanceMetres(a, b) <= 150 && jaccard(na, nb) >= 0.5;
}

/** Returns the master hotel this listing belongs to, if exactly one matches. */
export function findMaster(candidate: MappableHotel, masters: MasterHotel[]): MasterHotel | undefined {
  const matches = masters.filter((m) => isSameHotel(candidate, m));
  return matches.length === 1 ? matches[0] : undefined;
}
