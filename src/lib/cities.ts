/**
 * US city names that appear in card transaction descriptions.
 *
 * Card feeds format descriptions as MERCHANT CITY ST. Without knowing which
 * trailing words are places, there is no way to tell "STARBUCKS SEATTLE WA"
 * (city, drop it) from "THE DINER WA" (no city, keep the name) — and guessing
 * by word count gets one of them wrong whichever way you lean.
 *
 * This list is the largest US cities plus common suburbs, which covers the
 * overwhelming majority of real descriptions. A city that is missing simply
 * stays in the merchant name: the result is still consistent for that merchant,
 * just more verbose, and a rule or a rename fixes it.
 */

const CITY_LIST = `
new york los angeles chicago houston phoenix philadelphia san antonio san diego dallas austin
jacksonville fort worth columbus charlotte san francisco indianapolis seattle denver washington
boston el paso nashville detroit oklahoma city portland las vegas memphis louisville baltimore
milwaukee albuquerque tucson fresno sacramento kansas city mesa atlanta omaha colorado springs
raleigh virginia beach long beach miami oakland minneapolis tulsa bakersfield wichita arlington
aurora tampa new orleans cleveland honolulu anaheim lexington stockton corpus christi henderson
riverside newark saint paul st paul santa ana cincinnati irvine orlando pittsburgh st louis
saint louis greensboro jersey city anchorage lincoln plano durham buffalo chandler chula vista
toledo madison gilbert reno fort wayne north las vegas st petersburg saint petersburg laredo
irving chesapeake glendale winston salem scottsdale garland boise norfolk spokane fremont
richmond santa clarita san bernardino baton rouge hialeah tacoma modesto huntsville des moines
yonkers rochester moreno valley fayetteville fontana columbia worcester port st lucie little rock
augusta oxnard birmingham montgomery frisco amarillo salt lake city huntington beach grand rapids
overland park tallahassee grand prairie mckinney cape coral sioux falls peoria providence
vancouver knoxville brownsville chattanooga fort lauderdale newport news elk grove salem
pembroke pines eugene santa rosa cary rockford palmdale springfield sioux city pasadena
fort collins corona lancaster visalia pomona paterson joliet naperville killeen bellevue
sunnyvale escondido torrance hayward roseville thornton mcallen surprise denton midland
carrollton syracuse murfreesboro charleston west valley city dayton greeley pueblo
olathe waco clearwater lakewood west jordan westminster orange fullerton
pearland richardson tempe ontario santa clara league city miami gardens sandy springs
allentown daly city berkeley beaumont odessa lafayette provo el monte costa mesa
downey inglewood san mateo redmond kirkland renton everett kent auburn federal way
bothell issaquah shoreline burien edmonds lynnwood puyallup redwood city palo alto
mountain view menlo park cupertino milpitas alameda san leandro walnut creek concord
`;

const MULTI_WORD_CITIES = new Set<string>();
const SINGLE_WORD_CITIES = new Set<string>();

for (const raw of CITY_LIST.split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  // The list is space-separated, so reconstruct multi-word names by scanning
  // known two- and three-word prefixes. Simpler: treat each line's tokens as
  // single words, and register explicit multi-word names below.
  for (const word of line.split(/\s+/)) SINGLE_WORD_CITIES.add(word);
}

for (const name of [
  'new york', 'los angeles', 'san antonio', 'san diego', 'fort worth', 'san francisco',
  'oklahoma city', 'las vegas', 'colorado springs', 'virginia beach', 'long beach',
  'kansas city', 'new orleans', 'santa ana', 'chula vista', 'north las vegas',
  'saint paul', 'st paul', 'saint louis', 'st louis', 'jersey city', 'santa clarita',
  'san bernardino', 'baton rouge', 'des moines', 'moreno valley', 'port st lucie',
  'little rock', 'salt lake city', 'huntington beach', 'grand rapids', 'overland park',
  'grand prairie', 'cape coral', 'sioux falls', 'newport news', 'elk grove',
  'pembroke pines', 'santa rosa', 'fort collins', 'winston salem', 'sioux city',
  'west valley city', 'west jordan', 'league city', 'miami gardens', 'sandy springs',
  'daly city', 'costa mesa', 'san mateo', 'redwood city', 'palo alto', 'mountain view',
  'menlo park', 'san leandro', 'walnut creek', 'federal way', 'st petersburg',
  'saint petersburg', 'fort lauderdale', 'fort wayne',
]) {
  MULTI_WORD_CITIES.add(name);
}

/**
 * How many trailing words of `words` form a known city name (0 if none).
 * Checks longer names first so "SAN FRANCISCO" is not mistaken for "FRANCISCO".
 */
export function trailingCityLength(words: readonly string[]): number {
  const lower = words.map((w) => w.toLowerCase());
  for (const size of [3, 2]) {
    if (lower.length >= size) {
      const candidate = lower.slice(lower.length - size).join(' ');
      if (MULTI_WORD_CITIES.has(candidate)) return size;
    }
  }
  const last = lower[lower.length - 1];
  if (last && SINGLE_WORD_CITIES.has(last) && !MULTI_WORD_CITIES.has(last)) return 1;
  return 0;
}
