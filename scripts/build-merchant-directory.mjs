#!/usr/bin/env node
/**
 * Builds the bundled merchant directory: a few thousand well-known brand names,
 * each mapped to one of this app's spending categories.
 *
 *   node scripts/build-merchant-directory.mjs            # rebuild from the pinned version
 *   node scripts/build-merchant-directory.mjs --report   # also list what was left out
 *
 * The source is the OpenStreetMap name-suggestion-index (NSI), a community
 * curated list of brands, each tagged with what kind of place it is
 * (`shop=supermarket`, `amenity=fast_food`, `amenity=fuel`, …). That tag is the
 * whole trick: a supermarket is groceries, a fast food chain is eating out. NSI
 * is BSD-3-Clause licensed, which allows redistributing a derived list; the
 * notice is in public/THIRD_PARTY_NOTICES.md, which ships inside the extension.
 *
 * NSI is ~100 MB unpacked and almost none of it is needed, so it is NOT a
 * dependency. This script downloads the pinned version to a temp folder, keeps
 * the brands found in the US (or worldwide), and writes one small JSON file that
 * is committed. Nothing is fetched at runtime: the extension makes no network
 * calls, and that does not change.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NSI_VERSION = '8.0.20261101';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'categorize', 'data', 'merchant-directory.json');

/** NSI brand type -> category id. A type that is absent here is left out on purpose. */
const TYPE_TO_CATEGORY = {
  // Groceries
  'shop/supermarket': 'cat-groceries', 'shop/convenience': 'cat-groceries', 'shop/greengrocer': 'cat-groceries',
  'shop/butcher': 'cat-groceries', 'shop/seafood': 'cat-groceries', 'shop/deli': 'cat-groceries',
  'shop/alcohol': 'cat-groceries', 'shop/beverages': 'cat-groceries', 'shop/wholesale': 'cat-groceries',
  'shop/health_food': 'cat-groceries', 'shop/frozen_food': 'cat-groceries', 'shop/cheese': 'cat-groceries',
  'shop/wine': 'cat-groceries', 'shop/farm': 'cat-groceries',
  // Eating out
  'amenity/fast_food': 'cat-dining', 'amenity/restaurant': 'cat-dining', 'amenity/cafe': 'cat-dining',
  'amenity/ice_cream': 'cat-dining', 'amenity/pub': 'cat-dining', 'amenity/bar': 'cat-dining',
  'shop/bakery': 'cat-dining', 'shop/pastry': 'cat-dining', 'shop/confectionery': 'cat-dining',
  'shop/coffee': 'cat-dining', 'shop/tea': 'cat-dining', 'shop/chocolate': 'cat-dining',
  // Cars and getting around
  'amenity/fuel': 'cat-transport', 'amenity/charging_station': 'cat-transport', 'amenity/car_wash': 'cat-transport',
  'amenity/parking': 'cat-transport', 'amenity/bicycle_rental': 'cat-transport', 'amenity/car_sharing': 'cat-transport',
  'shop/car_repair': 'cat-transport', 'shop/tyres': 'cat-transport', 'shop/car_parts': 'cat-transport',
  'shop/car': 'cat-transport', 'shop/motorcycle': 'cat-transport', 'man_made/charge_point': 'cat-transport',
  // Travel
  'tourism/hotel': 'cat-travel', 'tourism/motel': 'cat-travel', 'tourism/hostel': 'cat-travel',
  'amenity/car_rental': 'cat-travel', 'shop/travel_agency': 'cat-travel',
  // Health
  'amenity/pharmacy': 'cat-health', 'amenity/dentist': 'cat-health', 'amenity/clinic': 'cat-health',
  'amenity/doctors': 'cat-health', 'amenity/hospital': 'cat-health', 'shop/chemist': 'cat-health',
  'shop/optician': 'cat-health', 'shop/hearing_aids': 'cat-health', 'shop/medical_supply': 'cat-health',
  'shop/nutrition_supplements': 'cat-health', 'leisure/fitness_centre': 'cat-health',
  'leisure/sports_centre': 'cat-health', 'healthcare/laboratory': 'cat-health',
  'healthcare/blood_donation': 'cat-health', 'healthcare/clinic': 'cat-health',
  // Fun
  'amenity/cinema': 'cat-entertainment', 'amenity/theatre': 'cat-entertainment',
  'leisure/bowling_alley': 'cat-entertainment', 'leisure/amusement_arcade': 'cat-entertainment',
  'leisure/trampoline_park': 'cat-entertainment', 'leisure/miniature_golf': 'cat-entertainment',
  'leisure/escape_game': 'cat-entertainment', 'tourism/theme_park': 'cat-entertainment',
  'shop/video_games': 'cat-entertainment', 'shop/music': 'cat-entertainment', 'shop/video': 'cat-entertainment',
  // House, garden, pets
  'shop/doityourself': 'cat-household', 'shop/hardware': 'cat-household', 'shop/furniture': 'cat-household',
  'shop/houseware': 'cat-household', 'shop/garden_centre': 'cat-household', 'shop/paint': 'cat-household',
  'shop/bed': 'cat-household', 'shop/kitchen': 'cat-household', 'shop/appliance': 'cat-household',
  'shop/trade': 'cat-household', 'shop/interior_decoration': 'cat-household', 'shop/flooring': 'cat-household',
  'shop/lighting': 'cat-household', 'shop/carpet': 'cat-household', 'shop/storage_rental': 'cat-household',
  'shop/laundry': 'cat-household', 'shop/dry_cleaning': 'cat-household', 'shop/pet': 'cat-household',
  'shop/pet_grooming': 'cat-household', 'shop/variety_store': 'cat-household', 'amenity/veterinary': 'cat-household',
  'shop/swimming_pool': 'cat-household', 'shop/agrarian': 'cat-household',
  // Shopping
  'shop/clothes': 'cat-shopping', 'shop/shoes': 'cat-shopping', 'shop/department_store': 'cat-shopping',
  'shop/jewelry': 'cat-shopping', 'shop/cosmetics': 'cat-shopping', 'shop/beauty': 'cat-shopping',
  'shop/watches': 'cat-shopping', 'shop/sports': 'cat-shopping', 'shop/electronics': 'cat-shopping',
  'shop/books': 'cat-shopping', 'shop/gift': 'cat-shopping', 'shop/bag': 'cat-shopping',
  'shop/outdoor': 'cat-shopping', 'shop/computer': 'cat-shopping', 'shop/perfumery': 'cat-shopping',
  'shop/fashion_accessories': 'cat-shopping', 'shop/second_hand': 'cat-shopping', 'shop/charity': 'cat-shopping',
  'shop/craft': 'cat-shopping', 'shop/stationery': 'cat-shopping', 'shop/hairdresser': 'cat-shopping',
  'shop/massage': 'cat-shopping', 'shop/art': 'cat-shopping', 'shop/frame': 'cat-shopping',
  'shop/fabric': 'cat-shopping', 'shop/party': 'cat-shopping', 'shop/bicycle': 'cat-shopping',
  'shop/hifi': 'cat-shopping', 'shop/leather': 'cat-shopping', 'shop/tailor': 'cat-shopping',
  'shop/tobacco': 'cat-shopping', 'shop/e-cigarette': 'cat-shopping', 'shop/cannabis': 'cat-shopping',
  'shop/erotic': 'cat-shopping', 'shop/golf': 'cat-shopping', 'shop/hunting': 'cat-shopping',
  'shop/fishing': 'cat-shopping', 'shop/musical_instrument': 'cat-shopping', 'shop/photo': 'cat-shopping',
  'shop/sewing': 'cat-shopping', 'shop/florist': 'cat-gifts', 'shop/baby_goods': 'cat-kids',
  // Kids
  'shop/toys': 'cat-kids', 'amenity/kindergarten': 'cat-kids', 'amenity/childcare': 'cat-kids',
  'amenity/prep_school': 'cat-kids',
  // Bills
  'shop/mobile_phone': 'cat-utilities', 'shop/telecommunication': 'cat-utilities',
  'office/telecommunication': 'cat-utilities', 'office/insurance': 'cat-utilities',
};

/**
 * Left out deliberately. Banks, ATMs and lenders appear in descriptions mostly
 * as the *other end of a transfer* ("CHASE CREDIT CRD AUTOPAY"), so filing them
 * under a spending category would be confidently wrong.
 */
const SKIPPED_ON_PURPOSE = new Set([
  'amenity/bank', 'amenity/atm', 'shop/money_lender', 'amenity/money_transfer', 'amenity/bureau_de_change',
  'amenity/payment_terminal', 'amenity/vending_machine', 'advertising/totem', 'office/estate_agent',
  'amenity/post_office', 'amenity/post_box', 'amenity/parcel_locker', 'shop/pawnbroker',
]);

/**
 * Many brands are tagged as more than one kind of place: Costco is a warehouse
 * club and a gas station, Shell is a gas station and a convenience store. When
 * the kinds disagree about the category, the brand's main business wins: a
 * lower rank here beats a higher one, and a tie drops the name as ambiguous.
 */
const TYPE_RANK = {
  'shop/supermarket': 1, 'shop/wholesale': 1, 'shop/department_store': 1, 'shop/furniture': 1,
  'shop/doityourself': 1, 'shop/clothes': 1, 'shop/variety_store': 1,
  'amenity/fuel': 2,
  'shop/convenience': 4,
};
const rankOf = (type) => TYPE_RANK[type] ?? 3;

/** Lowercase, drop apostrophes, and squeeze out everything that is not a letter or digit. */
const squash = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '');
const isLatin = (s) => /^[\x20-\x7eÀ-ɏ’]+$/.test(s);

const work = mkdtempSync(join(tmpdir(), 'ep-nsi-'));
try {
  console.log(`Downloading name-suggestion-index@${NSI_VERSION}…`);
  execFileSync('npm', ['pack', `name-suggestion-index@${NSI_VERSION}`, '--silent'], { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] });
  execFileSync('tar', ['xzf', `name-suggestion-index-${NSI_VERSION}.tgz`, 'package/dist/json/nsi.min.json'], { cwd: work });
  const { nsi } = JSON.parse(readFileSync(join(work, 'package/dist/json/nsi.min.json'), 'utf8'));

  /** squashed key -> { name, category, type } ; a key claimed by two categories is dropped. */
  const byKey = new Map();
  const clashes = new Set();
  const unmapped = new Map();

  for (const [path, group] of Object.entries(nsi)) {
    if (!path.startsWith('brands/')) continue;
    const type = path.slice('brands/'.length);
    const category = TYPE_TO_CATEGORY[type];

    for (const item of group.items) {
      const where = item.locationSet?.include ?? [];
      if (!where.some((w) => w === 'us' || w === '001')) continue;
      if (!category) {
        if (!SKIPPED_ON_PURPOSE.has(type)) unmapped.set(type, (unmapped.get(type) ?? 0) + 1);
        continue;
      }

      const names = [item.displayName, item.tags?.name, item.tags?.brand, item.tags?.['name:en'], ...(item.matchNames ?? [])]
        .filter((n) => typeof n === 'string' && isLatin(n));
      const display = names[0];
      if (!display) continue;

      for (const name of new Set(names)) {
        const key = squash(name.replace(/^the\s+/i, ''));
        if (key.length < 2) continue;
        const entry = { name: display, category, rank: rankOf(type), words: name.trim().split(/\s+/).length };
        const existing = byKey.get(key);
        if (!existing || entry.rank < existing.rank) {
          byKey.set(key, entry);
          clashes.delete(key);
        } else if (entry.rank === existing.rank && existing.category !== category) {
          clashes.add(key);
        }
      }
    }
  }
  for (const key of clashes) byKey.delete(key);

  // Compact shape: category -> ["key", "key", …]. Keys are already normalized,
  // so the app only has to build a Map at startup.
  const byCategory = {};
  for (const [key, { category, words }] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    // A trailing "+" marks a multi-word name, which is distinctive enough to
    // match as a prefix of a longer description.
    (byCategory[category] ??= []).push(words > 1 ? `${key}+` : key);
  }

  const out = {
    source: 'OpenStreetMap name-suggestion-index',
    version: NSI_VERSION,
    license: 'BSD-3-Clause',
    homepage: 'https://github.com/osmlab/name-suggestion-index',
    count: byKey.size,
    categories: byCategory,
  };
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);

  console.log(`${byKey.size} merchant names written to ${OUT}`);
  for (const [category, keys] of Object.entries(byCategory)) console.log(`  ${category.padEnd(20)} ${keys.length}`);
  console.log(`${clashes.size} names dropped because two kinds of business share them.`);
  if (process.argv.includes('--report')) {
    console.log('\nBrand types with no category mapping (US brand count):');
    for (const [type, n] of [...unmapped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${type}`);
    console.log(`\nDropped as ambiguous: ${[...clashes].sort().join(', ')}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
