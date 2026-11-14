#!/usr/bin/env node
/**
 * Generates a full year of made-up transactions for a fictional family of five,
 * across every kind of source the app can read, so the extension can be tried
 * end to end without anyone's real finances.
 *
 *   node scripts/generate-demo-data.mjs          # rewrite public/demo/
 *   node scripts/generate-demo-data.mjs --check  # fail if the files are stale
 *
 * The output is deterministic: a fixed seed, no clock, no locale. Running it
 * twice gives byte-identical files, which is what lets the files be committed
 * and lets a test assert they still match this script.
 *
 * Nothing here describes a real person, account or purchase. Bank and merchant
 * names are used only so the descriptions look like what a statement contains.
 *
 * The four CSVs deliberately differ in the ways real exports differ, so each
 * exercises a different path through column detection:
 *
 *   schwab-checking.csv       separate Withdrawal / Deposit columns, "$1,234.56"
 *   chase-sapphire.csv        one signed Amount, spending negative
 *   amex-blue-cash.csv        one signed Amount, spending POSITIVE, reference ids
 *   credit-union-savings.csv  Debit / Credit columns, ISO dates
 *   amazon-orders.html        an order-history page, with cancellations, returns
 *                             and refunds, most of it also charged to a card
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEMO_YEAR = 2025;
export const DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');

export const DEMO_ACCOUNTS = [
  { file: 'schwab-checking.csv', label: 'Schwab Checking …4471' },
  { file: 'chase-sapphire.csv', label: 'Chase Sapphire …8842' },
  { file: 'amex-blue-cash.csv', label: 'Amex Blue Cash …1006' },
  { file: 'credit-union-savings.csv', label: 'Cascade CU Savings …3390' },
];
export const DEMO_AMAZON_FILE = 'amazon-orders.html';
/** Lists the files and their account labels, for the in-app demo loader. */
export const DEMO_INDEX_FILE = 'index.json';

// ---------------------------------------------------------------- utilities

/** Small seeded PRNG (mulberry32). Math.random would make the files unstable. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');
const iso = (month, day) => `${DEMO_YEAR}-${pad(month)}-${pad(day)}`;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (s) => toDate(s).getUTCDay(); // 0 = Sunday
const monthOf = (s) => Number(s.slice(5, 7));
const dayOf = (s) => Number(s.slice(8, 10));
const lastDayOfMonth = (month) => new Date(Date.UTC(DEMO_YEAR, month, 0)).getUTCDate();
const usDate = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const longDate = (s) => `${MONTH_NAMES[monthOf(s) - 1]} ${dayOf(s)}, ${s.slice(0, 4)}`;
const shortDate = (s) => `${MONTH_NAMES[monthOf(s) - 1]} ${dayOf(s)}`;

/** 123456 -> "1234.56" (always unsigned). */
const plain = (cents) => (Math.abs(cents) / 100).toFixed(2);
/** 123456 -> "$1,234.56" (always unsigned). Hand-rolled so no locale is involved. */
const dollars = (cents) => {
  const [whole, frac] = plain(cents).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
};

const YEAR_DAYS = (() => {
  const days = [];
  for (let d = iso(1, 1); d <= iso(12, 31); d = addDays(d, 1)) days.push(d);
  return days;
})();

/** The family is out of town on these dates, so local habits pause. */
const AWAY = [
  [iso(4, 14), iso(4, 18)], // spring break, a cabin in the mountains
  [iso(7, 12), iso(7, 20)], // summer trip to San Diego
  [iso(11, 26), iso(11, 30)], // Thanksgiving with family in Denver
];
const isAway = (d) => AWAY.some(([from, to]) => d >= from && d <= to);
/** School is in session September to mid June. */
const inSchool = (d) => {
  const m = monthOf(d);
  return m >= 9 || m <= 5 || (m === 6 && dayOf(d) <= 18);
};

// ------------------------------------------------------------ everyday habits

/**
 * Things the family buys repeatedly. `w` is the expected number per week,
 * `chase` the share that goes on the Chase card rather than the Amex,
 * `weekend` a multiplier for Friday to Sunday, and `season` a per-month
 * multiplier. Several merchants deliberately have no starter rule, so the demo
 * leaves real categorizing to do.
 */
const HABITS = [
  // Groceries
  { d: ['TRADER JOE S #130', 'TRADER JOE S #157'], c: 'Groceries', a: [3800, 14500], w: 1.1, chase: 0.8, weekend: 1.4 },
  { d: ['SAFEWAY #1508', 'SAFEWAY #0423'], c: 'Groceries', a: [2200, 16500], w: 1.0, chase: 0.5 },
  { d: ['QFC #5847'], c: 'Groceries', a: [900, 7800], w: 0.6, chase: 0.6 },
  { d: ['COSTCO WHSE #0110'], c: 'Groceries', a: [14000, 42000], w: 0.45, chase: 1, weekend: 2.2 },
  { d: ['PCC COMMUNITY MARKETS'], c: 'Groceries', a: [1800, 9500], w: 0.25, chase: 0.7 },
  // Coffee and eating out
  { d: ['STARBUCKS STORE 03301', 'STARBUCKS STORE 10877'], c: 'Food & Drink', a: [475, 1890], w: 2.6, chase: 0.4 },
  { d: ['SQ *FERN & FINCH CAFE'], c: 'Food & Drink', a: [650, 3400], w: 0.9, chase: 0.6, weekend: 1.6 },
  { d: ['CHIPOTLE 1742'], c: 'Food & Drink', a: [3200, 6400], w: 0.45, chase: 0.7 },
  { d: ['TST* RED CEDAR PIZZA', 'MOD PIZZA GREENWOOD'], c: 'Food & Drink', a: [3400, 7800], w: 0.5, chase: 0.8, weekend: 2 },
  { d: ['DOORDASH*THAI GARDEN', 'DOORDASH*BURGER BARN', 'DOORDASH*SUSHI KO'], c: 'Food & Drink', a: [3800, 9200], w: 0.5, chase: 0.9, weekend: 1.5 },
  { d: ["MCDONALD'S F12345"], c: 'Food & Drink', a: [1400, 4200], w: 0.35, chase: 0.5 },
  { d: ["DICK'S DRIVE-IN"], c: 'Food & Drink', a: [1900, 4600], w: 0.3, chase: 0.6, weekend: 1.5 },
  { d: ['TST* THE HARBOR TABLE', 'TST* OLIVE & ASH'], c: 'Food & Drink', a: [7800, 18500], w: 0.3, chase: 0.9, weekend: 3 },
  // Fuel and getting around
  { d: ['SHELL OIL 57444120', 'CHEVRON 0093821', 'ARCO #42911'], c: 'Gas', a: [4200, 7900], w: 1.3, chase: 0.6 },
  { d: ['COSTCO GAS #0110'], c: 'Gas', a: [4800, 7400], w: 0.3, chase: 1 },
  { d: ['PAYBYPHONE PARKING'], c: 'Travel', a: [300, 1800], w: 0.4, chase: 0.7 },
  { d: ['UBER *TRIP', 'LYFT *RIDE'], c: 'Travel', a: [1100, 4200], w: 0.15, chase: 0.9, weekend: 2 },
  { d: ['GOOD TO GO TOLLS'], c: 'Travel', a: [400, 1500], w: 0.2, chase: 1 },
  // House and household
  { d: ['TARGET 00012345'], c: 'Shopping', a: [1800, 16500], w: 0.9, chase: 0.3, season: { 8: 1.8, 12: 1.8 } },
  { d: ['THE HOME DEPOT #4702', 'LOWES #01234'], c: 'Home', a: [1200, 14800], w: 0.3, chase: 0.8, weekend: 2, season: { 4: 1.6, 5: 1.8, 6: 1.6 } },
  { d: ['FRED MEYER #0351'], c: 'Shopping', a: [2400, 12800], w: 0.3, chase: 0.5 },
  // Health
  { d: ['CVS/PHARMACY #10432', 'WALGREENS #3921'], c: 'Health & Wellness', a: [600, 5400], w: 0.5, chase: 0.4 },
  { d: ['GREENLAKE PEDIATRIC CLINIC'], c: 'Health & Wellness', a: [3500, 3500], w: 0.14, chase: 0.8 },
  // Kids
  { d: ['SCHOOLPAY*LAKEVIEW ELEM'], c: 'Education', a: [6000, 6000], w: 0.33, chase: 0.9, school: true },
  { d: ['OLD NAVY US 5123', "CARTER'S #812"], c: 'Shopping', a: [2200, 11800], w: 0.25, chase: 0.3, season: { 8: 3 } },
  { d: ['PARKS REC SWIM LESSONS'], c: 'Entertainment', a: [8400, 8400], w: 0.12, chase: 0.9 },
  { d: ['SCHOLASTIC BOOK FAIRS'], c: 'Education', a: [1500, 4200], w: 0.08, chase: 0.5, school: true },
  // Fun
  { d: ['AMC 4412 ONLINE', 'REGAL CINEMAS 1123'], c: 'Entertainment', a: [3200, 8600], w: 0.2, chase: 0.8, weekend: 2.5 },
  { d: ['NINTENDO *ESHOP', 'STEAMGAMES.COM 4259522'], c: 'Entertainment', a: [499, 5999], w: 0.2, chase: 0.9 },
  { d: ['WOODLAND PARK ZOO', 'PACIFIC SCIENCE CENTER'], c: 'Entertainment', a: [4200, 12400], w: 0.1, chase: 0.8, weekend: 3 },
  { d: ['Prime Video *2K4LL1XX0'], c: 'Entertainment', a: [399, 599], w: 0.4, chase: 1 },
  // The dog
  { d: ['PETCO 1284', 'MUD BAY GREENWOOD'], c: 'Shopping', a: [1800, 8900], w: 0.35, chase: 0.5 },
  // Odds and ends
  { d: ['REI #11', 'NORDSTROM #0001', 'ETSY.COM*MULTIPLE SHOPS'], c: 'Shopping', a: [2400, 16800], w: 0.25, chase: 0.8, season: { 11: 1.6, 12: 3 } },
  { d: ['LES SCHWAB TIRES #0412', 'JIFFY LUBE #2291'], c: 'Automotive', a: [5400, 12900], w: 0.06, chase: 1 },
];

/** Charged on the same day every month. `card` is 'chase' or 'amex'. */
const MONTHLY = [
  { day: 2, d: 'GREENLIGHT FAMILY', c: 'Shopping', cents: 998, card: 'chase' },
  { day: 5, d: 'NETFLIX.COM', c: 'Entertainment', cents: 2299, card: 'chase' },
  { day: 8, d: 'BRIGHT SMILES ORTHODONTICS', c: 'Health & Wellness', cents: 18900, card: 'chase' },
  { day: 9, d: 'SPOTIFY USA', c: 'Entertainment', cents: 1999, card: 'chase' },
  { day: 11, d: 'COMCAST CABLE COMM', c: 'Bills & Utilities', cents: 8999, card: 'chase' },
  { day: 14, d: 'DISNEY PLUS', c: 'Entertainment', cents: 1599, card: 'chase' },
  { day: 17, d: 'APPLE.COM/BILL', c: 'Shopping', cents: 299, card: 'chase' },
  { day: 20, d: 'THE NEW YORK TIMES', c: 'Shopping', cents: 1700, card: 'chase' },
  { day: 22, d: 'APPLE.COM/BILL', c: 'Shopping', cents: 999, card: 'chase' },
  { day: 1, d: 'YMCA OF GREATER SEATTLE', c: 'Fitness', cents: 9800, card: 'amex' },
  { day: 19, d: 'AUDIBLE*2K4LL1XX0', c: 'Merchandise', cents: 1495, card: 'amex' },
  { day: 25, d: 'DROPBOX*7HG2KLM9Q', c: 'Merchandise', cents: 1199, card: 'amex' },
];

/** One-off card charges: [month, day, description, cents, chase category]. */
const ONE_OFFS_CHASE = [
  // Annual things
  [2, 11, 'AMAZON PRIME*2K4LL1XX0', 15339, 'Shopping'],
  [2, 26, 'INTUIT *TURBOTAX', 12900, 'Professional Services'],
  [5, 14, 'WA DOL VEHICLE LICENSING', 18725, 'Automotive'],
  [6, 2, 'COSTCO *ANNUAL RENEWAL', 13000, 'Shopping'],
  [10, 9, 'WA DOL VEHICLE LICENSING', 14275, 'Automotive'],
  // Flights are bought per passenger, so five identical charges on one day.
  ...[1, 2, 3, 4, 5].map((n) => [2, 20, `ALASKA AIR 027218455019${n}`, 31820, 'Travel']),
  ...[1, 2, 3, 4, 5].map((n) => [9, 4, `ALASKA AIR 027231907744${n}`, 26440, 'Travel']),
  // Spring break
  [3, 2, 'AIRBNB * HMK4R2TQ9X', 74218, 'Travel'],
  [4, 14, 'CHEVRON 0204417 MONROE WA', 6214, 'Gas'],
  [4, 15, 'TST* ALPINE BREWING LEAVENWORTH WA', 11840, 'Food & Drink'],
  [4, 16, 'LEAVENWORTH ADVENTURE PARK', 14500, 'Entertainment'],
  [4, 16, 'SQ *GINGERBREAD BAKERY LEAVENWORTH WA', 3875, 'Food & Drink'],
  [4, 17, 'DANS FOOD MARKET LEAVENWORTH WA', 8421, 'Groceries'],
  [4, 18, 'SHELL OIL 57440091 LEAVENWORTH WA', 5890, 'Gas'],
  // San Diego
  [7, 12, 'HERTZ RENT-A-CAR SAN DIEGO CA', 48612, 'Travel'],
  [7, 12, 'TST* HARBORSIDE TACOS SAN DIEGO CA', 9740, 'Food & Drink'],
  [7, 13, 'SAN DIEGO ZOO', 31200, 'Entertainment'],
  [7, 13, 'SQ *BAYSIDE COFFEE SAN DIEGO CA', 2385, 'Food & Drink'],
  [7, 14, 'TST* PACIFIC BEACH FISH CO SAN DIEGO CA', 13420, 'Food & Drink'],
  [7, 15, 'LEGOLAND CALIFORNIA', 52995, 'Entertainment'],
  [7, 15, 'LEGOLAND CALIFORNIA FOOD', 8760, 'Food & Drink'],
  [7, 16, 'VONS #2104 SAN DIEGO CA', 6480, 'Groceries'],
  [7, 16, 'UBER *TRIP', 2840, 'Travel'],
  [7, 17, 'USS MIDWAY MUSEUM', 13400, 'Entertainment'],
  [7, 17, 'TST* OLD TOWN CANTINA SAN DIEGO CA', 15690, 'Food & Drink'],
  [7, 18, 'CHEVRON 0098812 SAN DIEGO CA', 5760, 'Gas'],
  [7, 19, 'SQ *SUNSET GELATO SAN DIEGO CA', 3150, 'Food & Drink'],
  [7, 20, 'MARRIOTT SAN DIEGO MARINA', 218436, 'Travel'],
  // Thanksgiving in Denver
  [11, 26, 'HERTZ RENT-A-CAR DENVER CO', 29844, 'Travel'],
  [11, 27, 'KING SOOPERS #0061 DENVER CO', 14230, 'Groceries'],
  [11, 28, 'TST* MILE HIGH DINER DENVER CO', 12680, 'Food & Drink'],
  [11, 29, 'DENVER MUSEUM OF NATURE', 9800, 'Entertainment'],
  [11, 30, 'SHELL OIL 57449906 DENVER CO', 4410, 'Gas'],
  // Kids
  [3, 15, 'ORCA YOUTH SOCCER CLUB', 18500, 'Entertainment'],
  [3, 15, 'ORCA YOUTH SOCCER CLUB', 18500, 'Entertainment'],
  [8, 12, 'ORCA YOUTH SOCCER CLUB', 18500, 'Entertainment'],
  [8, 12, 'ORCA YOUTH SOCCER CLUB', 18500, 'Entertainment'],
  [3, 22, 'SKY HIGH TRAMPOLINE PARK', 28900, 'Entertainment'],
  [3, 21, 'SQ *SWEET CRUMB BAKERY', 6400, 'Food & Drink'],
  [10, 4, 'SOUTHGATE ROLLER RINK', 24500, 'Entertainment'],
  [10, 3, 'SQ *SWEET CRUMB BAKERY', 5800, 'Food & Drink'],
  [6, 23, 'YMCA SUMMER DAY CAMP', 77000, 'Education'],
  [6, 30, 'YMCA SUMMER DAY CAMP', 77000, 'Education'],
  [7, 28, 'YMCA SUMMER DAY CAMP', 77000, 'Education'],
  [8, 4, 'YMCA SUMMER DAY CAMP', 77000, 'Education'],
  [8, 23, 'APPLE STORE #R020', 121275, 'Shopping'],
  [10, 28, 'SPIRIT HALLOWEEN 60412', 9641, 'Shopping'],
  // Health
  [1, 9, 'EVERGREEN FAMILY DENTAL', 9600, 'Health & Wellness'],
  [6, 12, 'EVERGREEN FAMILY DENTAL', 21450, 'Health & Wellness'],
  [9, 9, 'CLEARVIEW OPTICAL', 28900, 'Health & Wellness'],
  [4, 29, 'GREENWOOD VETERINARY HOSP', 31240, 'Health & Wellness'],
  [10, 14, 'GREENWOOD VETERINARY HOSP', 8600, 'Health & Wellness'],
  // House and car
  [6, 7, 'THE HOME DEPOT #4702', 128477, 'Home'],
  [6, 14, 'THE HOME DEPOT #4702', 41209, 'Home'],
  [9, 16, 'GREENWOOD AUTO REPAIR', 184652, 'Automotive'],
  // December
  [12, 2, 'PTA LAKEVIEW ELEMENTARY', 10000, 'Gifts & Donations'],
  [12, 6, 'BEST BUY 00004812', 36415, 'Shopping'],
  [12, 9, 'BARNES & NOBLE #2278', 7235, 'Shopping'],
  [12, 13, 'LEGO STORE BELLEVUE WA', 21840, 'Shopping'],
  [12, 20, 'NORTHWEST FAMILY FOOD BANK', 15000, 'Gifts & Donations'],
];

// -------------------------------------------------------------------- Amazon

/** [name, price in cents]. Names avoid words the order parser reads as a status. */
const CATALOG = [
  ['Crayola Washable Markers 40 Count', 1499], ['Kids Insulated Water Bottle 2-Pack', 2199],
  ['AA Batteries 48 Pack', 1899], ['Dishwasher Pods 82 Count', 2197], ['Paper Towels 12 Mega Rolls', 2848],
  ['Toilet Paper 30 Family Rolls', 3142], ['Laundry Detergent 154 oz', 1997], ['Dog Food Salmon Recipe 30 lb', 5498],
  ['Dog Poop Bags 900 Count', 1399], ['LEGO Classic Brick Box', 3499], ['LEGO City Fire Station', 6399],
  ['Squishmallow Plush 12 Inch', 1699], ['Kids Bike Helmet', 2995], ['Soccer Shin Guards Youth', 1299],
  ['Soccer Ball Size 4', 1849], ['Swim Goggles Kids 2-Pack', 1599], ['Composition Notebooks 12 Pack', 1379],
  ['Ticonderoga Pencils 96 Pack', 1596], ['Kids Backpack With Lunch Bag', 3299], ['Bento Lunch Box', 2499],
  ['Chapter Book Box Set', 2714], ['Graphic Novel Collection Vol 1-4', 3196], ['Picture Book Hardcover', 1289],
  ['Board Game Family Edition', 2499], ['Jigsaw Puzzle 1000 Pieces', 1795], ['Playing Cards Card Game', 999],
  ['Childrens Multivitamin Gummies', 1647], ['Bandages Variety Pack', 1099], ['Kids Toothpaste 3-Pack', 1182],
  ['Sunscreen SPF 50 2-Pack', 1987], ['Hand Soap Refill 56 oz', 1294], ['HEPA Air Filter 20x25x1 4-Pack', 4399],
  ['LED Light Bulbs 16 Pack', 2299], ['Extension Cord 25 ft', 1949], ['USB-C Charging Cable 3-Pack', 1299],
  ['Phone Case Clear', 1599], ['Kids Tablet Case', 2399], ['Wireless Mouse', 2499], ['Printer Ink Black XL', 4289],
  ['Printer Paper 5 Reams', 3499], ['Kitchen Trash Bags 120 Count', 2099], ['Zip Storage Bags Gallon 150 Count', 1449],
  ['Stainless Steel Skillet 12 Inch', 4999], ['Silicone Baking Mats 3-Pack', 1699], ['Coffee Filters 400 Count', 899],
  ['Whole Bean Coffee 2 lb', 2399], ['Granola Bars 60 Count', 1998], ['Fruit Snacks 90 Pouches', 1849],
  ['Kids Rain Jacket', 3495], ['Kids Snow Boots', 4499], ['Wool Socks 6-Pack', 2299], ['Toddler Pajamas 2-Pack', 2499],
  ['Mens Running Shorts', 2800], ['Womens Fleece Pullover', 4590], ['Yoga Mat', 2599], ['Garden Hose 50 ft', 3999],
  ['Tomato Cage 5-Pack', 2749], ['Bird Seed 20 lb', 2399], ['Car Phone Mount', 1899], ['Windshield Wipers Pair', 3299],
  ['Vacuum Filters 4-Pack', 1699], ['Storage Bins With Lids 6-Pack', 4999], ['Label Maker Tape 4-Pack', 1899],
  ['Birthday Party Supplies Kit', 2399], ['Wrapping Paper 6 Rolls', 1799], ['String Lights 100 ft', 2999],
];
const SALES_TAX = 0.1035;

/**
 * The orders that make the demo interesting. Each is placed on a fixed date so
 * that every refund credit lands where only the intended order can claim it.
 * Totals here equal the sum of the items, so a refund of an item is a refund of
 * exactly what that item cost.
 */
const SPECIAL_ORDERS = [
  // Cancelled before charging: no card charge at all.
  { date: iso(2, 4), kind: 'cancelled', items: [['Standing Desk Lamp', 12999]] },
  { date: iso(5, 27), kind: 'cancelled', items: [['Inflatable Pool 10 ft', 8999]] },
  { date: iso(9, 9), kind: 'cancelled', items: [['Kids Scooter', 6499], ['Scooter Bell', 899]] },
  { date: iso(12, 2), kind: 'cancelled', items: [['Robot Building Kit', 14999]] },
  // Returned, and Amazon says how much came back.
  { date: iso(1, 14), kind: 'refund-full', items: [['Kids Winter Coat', 6800]], refund: 6800, creditOn: iso(1, 27) },
  { date: iso(5, 6), kind: 'refund-full', items: [['Wireless Keyboard', 8900]], refund: 8200, creditOn: iso(5, 19) },
  { date: iso(9, 30), kind: 'refund-full', items: [['Halloween Costume Dragon', 4200]], refund: 4200, creditOn: iso(10, 10) },
  // One item of several came back.
  { date: iso(2, 18), kind: 'refund-partial', items: [['Running Shoes', 7000], ['Wool Socks 3-Pack', 3000], ['Shoe Insoles', 2000]], refund: 7000, creditOn: iso(3, 3) },
  { date: iso(7, 22), kind: 'refund-partial', items: [['Kids Swimsuit', 2600], ['Beach Towels 4-Pack', 3800]], refund: 2600, creditOn: iso(8, 4) },
  { date: iso(11, 25), kind: 'refund-partial', items: [['Wireless Earbuds', 5900], ['Earbud Case', 1200]], refund: 5900, creditOn: iso(12, 5) },
  // Returned, but Amazon does not say how much came back: the card credit settles it.
  { date: iso(3, 20), kind: 'return-credit', items: [['Bluetooth Speaker', 5400]], credit: 5400, creditOn: iso(4, 1) },
  { date: iso(6, 10), kind: 'return-credit', items: [['Camping Lantern 2-Pack', 3600]], credit: 3600, creditOn: iso(6, 21) },
  { date: iso(10, 21), kind: 'return-credit', items: [['Espresso Machine', 6450]], credit: 5800, creditOn: iso(11, 3) },
  // Returned, and no refund ever showed up: money worth chasing.
  { date: iso(8, 19), kind: 'return-missing', items: [['Desk Organizer', 4550]] },
  { date: iso(12, 16), kind: 'return-started', items: [['Kids Smartwatch', 7900]] },
  // The same thing bought twice, two days apart: an honestly ambiguous match.
  { date: iso(4, 8), kind: 'delivered', items: [['Reusable Snack Bags 10-Pack', 2419]] },
  { date: iso(4, 10), kind: 'delivered', items: [['Reusable Snack Bags 10-Pack', 2419]] },
];

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function renderOrder(order) {
  const k = order.kind;
  const status =
    k === 'cancelled' ? 'Cancelled'
    : k === 'refund-full' || k === 'return-credit' || k === 'return-missing' ? 'Return complete'
    : k === 'return-started' ? 'Return started'
    : `Delivered ${shortDate(addDays(order.date, 2))}`;

  const items = order.items.map(([name, cents, qty], i) => {
    let note = '';
    if (k === 'refund-full') note = `\n        <span class="a-color-success">Refunded ${dollars(order.refund)}</span>`;
    if (k === 'refund-partial' && i === 0) {
      note = `\n        <span class="a-color-success">Return complete. Refunded ${dollars(order.refund)}</span>`;
    }
    const quantity = qty && qty > 1 ? `\n        <span>Qty: ${qty}</span>` : '';
    return `      <div class="yohtmlc-item">
        <a class="a-link-normal yohtmlc-product-title" href="/dp/${order.asins[i]}">${escapeHtml(name)}</a>
        <span class="yohtmlc-item-price">${dollars(cents)}</span>${quantity}${note}
      </div>`;
  });

  return `  <div class="order-card js-order-card">
    <div class="order-header">
      <div class="a-column"><span>Order placed</span><span>${longDate(order.date)}</span></div>
      <div class="a-column"><span>Total</span><span>${dollars(order.total)}</span></div>
      <div class="a-column"><span>Order # ${order.number}</span></div>
    </div>
    <div class="shipment">
      <div class="delivery-box__primary-text">${status}</div>
${items.join('\n')}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ generate

/**
 * Build every demo file in memory.
 * @returns {{ files: Record<string, string>, manifest: object }}
 */
export function generateDemoData() {
  const rand = makeRng(20250101);
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;
  const code = (length) => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
    return out;
  };

  /** Card rows: cents is signed, negative = money out. */
  const chase = [];
  const amex = [];
  const spend = (card, date, desc, cents, category, type = 'Sale') =>
    (card === 'chase' ? chase : amex).push({ date, desc, cents: -cents, category, type });
  const credit = (card, date, desc, cents, category, type = 'Return') =>
    (card === 'chase' ? chase : amex).push({ date, desc, cents, category, type });

  // --- Everyday habits
  for (const date of YEAR_DAYS) {
    if (isAway(date)) continue;
    const dow = weekday(date);
    const isWeekend = dow === 0 || dow === 5 || dow === 6;
    for (const habit of HABITS) {
      if (habit.school && !inSchool(date)) continue;
      let p = habit.w / 7;
      if (habit.weekend) p *= isWeekend ? habit.weekend : 0.7;
      if (habit.season) p *= habit.season[monthOf(date)] ?? 1;
      const count = Math.floor(p) + (chance(p % 1) ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const card = chance(habit.chase) ? 'chase' : 'amex';
        const base = pick(habit.d);
        // Amex statements carry the city; Chase ones mostly do not.
        const desc = card === 'amex' && !/[*.]/.test(base) ? `${base} SEATTLE WA` : base;
        spend(card, date, desc, int(habit.a[0], habit.a[1]), habit.c);
      }
    }
  }

  // --- Subscriptions and other monthly charges
  for (let month = 1; month <= 12; month++) {
    for (const m of MONTHLY) spend(m.card, iso(month, m.day), m.d, m.cents, m.c);
  }

  // --- One-offs
  for (const [month, day, desc, cents, category] of ONE_OFFS_CHASE) spend('chase', iso(month, day), desc, cents, category);
  spend('chase', iso(3, 1), 'ANNUAL MEMBERSHIP FEE', 9500, 'Fees & Adjustments', 'Fee');
  credit('chase', iso(8, 20), 'OLD NAVY US 5123', 4218, 'Shopping');
  credit('amex', iso(12, 28), 'TARGET 00012345 SEATTLE WA', 3640, 'Merchandise');

  // --- Amazon orders
  const orders = [];
  const usedNumbers = new Set();
  const orderNumber = () => {
    for (;;) {
      const n = `11${int(1, 4)}-${pad(int(0, 9999999), 7)}-${pad(int(0, 9999999), 7)}`;
      if (!usedNumbers.has(n)) {
        usedNumbers.add(n);
        return n;
      }
    }
  };
  const asin = () => `B0${code(8)}`;

  for (const special of SPECIAL_ORDERS) {
    orders.push({
      ...special,
      number: orderNumber(),
      asins: special.items.map(asin),
      total: special.items.reduce((sum, [, cents]) => sum + cents, 0),
      card: 'chase',
    });
  }

  /** Two orders with the same total a few days apart would be a second, unplanned ambiguity. */
  const totalClashes = (date, total) =>
    orders.some((o) => o.total === total && Math.abs((toDate(o.date) - toDate(date)) / 86_400_000) <= 8);
  const specialDates = new Set(SPECIAL_ORDERS.map((o) => o.date));

  for (const date of YEAR_DAYS) {
    if (date > iso(12, 28) || specialDates.has(date)) continue;
    let p = 0.27;
    if (monthOf(date) === 12) p *= 1.7;
    if (isAway(date)) p *= 0.3;
    if (!chance(p)) continue;

    for (let attempt = 0; attempt < 20; attempt++) {
      const roll = rand();
      const itemCount = roll < 0.55 ? 1 : roll < 0.85 ? 2 : 3;
      const items = [];
      while (items.length < itemCount) {
        const [name, cents] = pick(CATALOG);
        if (items.some(([n]) => n === name)) continue;
        items.push([name, cents, cents < 2000 && chance(0.12) ? 2 : 1]);
      }
      const subtotal = items.reduce((sum, [, cents, qty]) => sum + cents * qty, 0);
      const total = subtotal + Math.round(subtotal * SALES_TAX);
      if (totalClashes(date, total)) continue;
      orders.push({
        date, kind: 'delivered', items, total, number: orderNumber(), asins: items.map(asin),
        card: chance(0.85) ? 'chase' : 'amex',
      });
      break;
    }
  }
  orders.sort((a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number));

  // --- The card side of each Amazon order
  for (const order of orders) {
    if (order.kind === 'cancelled') continue;
    const special = SPECIAL_ORDERS.some((s) => s.date === order.date);
    const chargeDate = addDays(order.date, special ? 1 : int(0, 2));
    const desc = order.card === 'amex'
      ? 'AMAZON MARKETPLACE NA PA'
      : `${chance(0.7) ? 'AMZN Mktp US' : 'Amazon.com'}*${code(9)}`;
    spend(order.card, chargeDate, desc, order.total, order.card === 'amex' ? 'Merchandise' : 'Shopping');

    const back = order.refund ?? order.credit;
    if (back) credit('chase', order.creditOn, `AMZN Mktp US*${code(9)}`, back, 'Shopping');
  }

  // --- Card payments, paid in full from checking each month
  const netCharges = (rows, month) =>
    rows.filter((r) => monthOf(r.date) === month && r.type !== 'Payment').reduce((sum, r) => sum - r.cents, 0);
  const chasePayments = [];
  const amexPayments = [];
  for (let month = 1; month <= 12; month++) {
    // January pays off a December that is not part of this export.
    chasePayments.push({ date: iso(month, 3), cents: month === 1 ? 451238 : netCharges(chase, month - 1) });
    amexPayments.push({ date: iso(month, 12), cents: month === 1 ? 138820 : netCharges(amex, month - 1) });
  }
  for (const p of chasePayments) chase.push({ date: p.date, desc: 'Payment Thank You - Web', cents: p.cents, category: '', type: 'Payment' });
  for (const p of amexPayments) amex.push({ date: p.date, desc: 'AUTOPAY PAYMENT - THANK YOU', cents: p.cents, category: '', type: 'Payment' });

  // --- Checking
  const checking = [];
  const out = (date, type, desc, cents, checkNo = '') => checking.push({ date, type, desc, cents: -cents, checkNo });
  const dep = (date, type, desc, cents) => checking.push({ date, type, desc, cents, checkNo: '' });
  /** Paydays that fall on a weekend are paid the Friday before. */
  const businessDay = (date) => {
    const dow = weekday(date);
    return dow === 6 ? addDays(date, -1) : dow === 0 ? addDays(date, -2) : date;
  };

  // Two incomes: one paid every other Friday, one on the 15th and month end.
  for (let date = iso(1, 3); date <= iso(12, 31); date = addDays(date, 14)) {
    dep(date, 'DEP', 'PAYROLL DIRECT DEP NORTHLAKE SOFTWARE', date < iso(7, 1) ? 365218 : 379844);
  }
  for (let month = 1; month <= 12; month++) {
    dep(businessDay(iso(month, 15)), 'DEP', 'EVERGREEN SCHOOL DIST PAYROLL', 214066);
    dep(businessDay(iso(month, lastDayOfMonth(month))), 'DEP', 'EVERGREEN SCHOOL DIST PAYROLL', 214066);
  }
  dep(iso(2, 28), 'DEP', 'NORTHLAKE SOFTWARE BONUS DIRECT DEP', 420000);
  dep(iso(3, 12), 'ACH', 'IRS TREAS 310 TAX REF', 231800);
  for (const [month, day, cents] of [[3, 22, 10000], [6, 28, 10000], [10, 4, 10000], [12, 24, 30000]]) {
    dep(iso(month, day), 'ACH', 'ZELLE PAYMENT FROM R ALVAREZ', cents);
  }

  let checkNo = 1041;
  const savingsMoves = []; // {date, cents} positive = into savings
  for (let month = 1; month <= 12; month++) {
    const school = month >= 9 || month <= 6;
    out(iso(month, 1), 'ACH', 'ROCKET MORTGAGE LOAN PMT', 284517);
    if (school) out(iso(month, 1), 'ACH', 'KIDSPACE AFTER SCHOOL ACH', 64000);
    out(iso(month, 2), 'TRANSFER', 'ONLINE TRANSFER TO CASCADE CU SAV 3390', 60000);
    savingsMoves.push({ date: iso(month, 2), cents: 60000 });
    out(iso(month, 3), 'ACH', 'CHASE CREDIT CRD AUTOPAY', chasePayments[month - 1].cents);
    out(iso(month, 5), 'ACH', 'TOYOTA FINANCIAL RETAIL PMT', 41238);
    if (school) out(iso(month, 6), 'CHECK', `Check Paid #${checkNo}`, 24000, String(checkNo++));
    out(iso(month, 10), 'ACH', 'WA529 COLLEGE SAVINGS CONTRIB', 30000);
    out(iso(month, 12), 'ACH', 'AMEX EPAYMENT ACH PMT', amexPayments[month - 1].cents);
    if (month % 2 === 0) out(iso(month, 15), 'ACH', 'CITY OF SEATTLE UTILITIES', int(24000, 33000));
    out(iso(month, 18), 'ACH', 'STATE FARM INSURANCE PREM', 26840);
    // Heating makes the energy bill swing with the season.
    const winter = Math.cos(((month - 1) / 12) * 2 * Math.PI);
    out(iso(month, 22), 'ACH', 'PUGET SOUND ENERGY BILLPAY', Math.round(14500 + 9500 * winter) + int(-1200, 1200));
    out(iso(month, 27), 'ACH', 'VERIZON WIRELESS PAYMENTS', 18542);
    dep(iso(month, lastDayOfMonth(month)), 'INTADJUST', 'INTEREST PAID', int(38, 121));
  }
  for (const [month, day, cents] of [[6, 20, 250000], [9, 17, 185000], [12, 8, 120000]]) {
    dep(iso(month, day), 'TRANSFER', 'TRANSFER FROM CASCADE CU SAV 3390', cents);
    savingsMoves.push({ date: iso(month, day), cents: -cents });
  }
  for (const date of YEAR_DAYS) {
    if (isAway(date)) continue;
    if (chance(0.065)) out(date, 'ATM', 'ATM WITHDRAWAL 4TH AVE SEATTLE WA', int(3, 10) * 2000);
    if (chance(0.06)) out(date, 'ACH', 'ZELLE PAYMENT TO J NAKAMURA', int(12, 20) * 500);
    if (chance(0.07)) out(date, 'ACH', `VENMO PAYMENT ${int(1020000000, 1029999999)}`, int(1200, 8500));
    const m = monthOf(date);
    if (weekday(date) === 0 && m >= 5 && m <= 10 && chance(0.5)) {
      out(date, 'VISA', 'BALLARD FARMERS MARKET SEATTLE WA', int(1800, 5500));
    }
  }
  dep(iso(4, 30), 'ACH', 'ATM FEE REBATE', 350);
  dep(iso(8, 29), 'ACH', 'ATM FEE REBATE', 700);

  // --- Savings
  const savings = savingsMoves.map((m) => ({
    date: m.date,
    desc: m.cents > 0 ? 'TRANSFER FROM SCHWAB CHECKING 4471' : 'TRANSFER TO SCHWAB CHECKING 4471',
    cents: m.cents,
  }));
  {
    let balance = 1840000;
    for (let month = 1; month <= 12; month++) {
      balance += savingsMoves.filter((m) => monthOf(m.date) === month).reduce((sum, m) => sum + m.cents, 0);
      const interest = Math.round((balance * 0.039) / 12);
      balance += interest;
      savings.push({ date: iso(month, lastDayOfMonth(month)), desc: 'DIVIDEND EARNED', cents: interest });
    }
  }

  // ---------------------------------------------------------------- render
  /** Oldest first, keeping same-day rows in the order they were created. */
  const byDate = (rows) => rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i).map((x) => x.r);
  /** Add a running balance, then flip to newest first, as bank exports are. */
  const withBalance = (rows, opening) => {
    let balance = opening;
    return byDate(rows).map((r) => ({ ...r, balance: (balance += r.cents) })).reverse();
  };

  const checkingRows = withBalance(checking, 1150000);
  const savingsRows = withBalance(savings, 1840000);
  const chaseRows = byDate(chase).reverse();
  const amexRows = byDate(amex).reverse();

  const q = (v) => `"${v}"`;
  const files = {};

  files['schwab-checking.csv'] = [
    ['Date', 'Type', 'Check #', 'Description', 'Withdrawal', 'Deposit', 'RunningBalance'].map(q).join(','),
    ...checkingRows.map((r) => [
      usDate(r.date), r.type, r.checkNo, r.desc,
      r.cents < 0 ? dollars(r.cents) : '', r.cents > 0 ? dollars(r.cents) : '', dollars(r.balance),
    ].map(q).join(',')),
  ].join('\n') + '\n';

  files['chase-sapphire.csv'] = [
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
    ...chaseRows.map((r) => [
      usDate(r.date), usDate(addDays(r.date, r.type === 'Payment' ? 0 : 1)), r.desc, r.category, r.type,
      `${r.cents < 0 ? '-' : ''}${plain(r.cents)}`, '',
    ].join(',')),
  ].join('\n') + '\n';

  // Amex writes charges as positive numbers, the opposite of Chase.
  files['amex-blue-cash.csv'] = [
    'Date,Description,Amount,Reference,Category',
    ...amexRows.map((r, i) => [
      usDate(r.date), r.desc, `${r.cents > 0 ? '-' : ''}${plain(r.cents)}`,
      `3202${pad(amexRows.length - i, 5)}${pad((i * 7919) % 100000, 5)}`, r.category,
    ].join(',')),
  ].join('\n') + '\n';

  files['credit-union-savings.csv'] = [
    'Date,Description,Debit,Credit,Balance',
    ...savingsRows.map((r) => [
      r.date, r.desc, r.cents < 0 ? plain(r.cents) : '', r.cents > 0 ? plain(r.cents) : '', plain(r.balance),
    ].join(',')),
  ].join('\n') + '\n';

  files[DEMO_AMAZON_FILE] = `<!doctype html>
<html><body>
<!-- Made-up demo data: a fictional family's ${DEMO_YEAR} order history. Not a real Amazon page. -->
<div id="ordersContainer">
  <h1>Your Orders</h1>
  <p>${orders.length} orders placed in ${DEMO_YEAR}</p>

${orders.map(renderOrder).join('\n\n')}
</div>
</body></html>
`;

  files[DEMO_INDEX_FILE] =
    JSON.stringify({ year: DEMO_YEAR, accounts: DEMO_ACCOUNTS, amazon: DEMO_AMAZON_FILE }, null, 2) + '\n';

  // -------------------------------------------------------------- manifest
  // What the data is *meant* to contain, stated independently of the files, so
  // a test can check the app reads back what was intended.
  const flow = (rows) => ({
    rows: rows.length,
    outCents: rows.filter((r) => r.cents < 0).reduce((sum, r) => sum - r.cents, 0),
    inCents: rows.filter((r) => r.cents > 0).reduce((sum, r) => sum + r.cents, 0),
  });
  const ofKind = (...kinds) => orders.filter((o) => kinds.includes(o.kind));

  const manifest = {
    year: DEMO_YEAR,
    accounts: {
      'schwab-checking.csv': { label: DEMO_ACCOUNTS[0].label, ...flow(checking), lowestBalanceCents: Math.min(...checkingRows.map((r) => r.balance)) },
      'chase-sapphire.csv': { label: DEMO_ACCOUNTS[1].label, ...flow(chase) },
      'amex-blue-cash.csv': { label: DEMO_ACCOUNTS[2].label, ...flow(amex) },
      'credit-union-savings.csv': { label: DEMO_ACCOUNTS[3].label, ...flow(savings) },
    },
    amazon: {
      orders: orders.length,
      faceValueCents: orders.reduce((sum, o) => sum + o.total, 0),
      cancelled: ofKind('cancelled').length,
      // Every order that was not cancelled was charged to a card.
      purchaseLinks: orders.length - ofKind('cancelled').length,
      chargedToAmex: orders.filter((o) => o.card === 'amex').length,
      ambiguousPurchaseLinks: 1,
      explicitRefunds: ofKind('refund-full', 'refund-partial').map((o) => ({ order: o.number, cents: o.refund })),
      refundSettlements: ofKind('return-credit').map((o) => ({ order: o.number, cents: o.credit })),
      unsettledReturns: ofKind('return-missing', 'return-started').map((o) => o.number),
    },
  };
  manifest.totalRows =
    Object.values(manifest.accounts).reduce((sum, a) => sum + a.rows, 0) + manifest.amazon.orders;

  return { files, manifest };
}

// ----------------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, manifest } = generateDemoData();

  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(
      ([name, content]) => !existsSync(join(DEMO_DIR, name)) || readFileSync(join(DEMO_DIR, name), 'utf8') !== content,
    );
    if (stale.length > 0) {
      console.error(`Stale demo files: ${stale.map(([name]) => name).join(', ')}. Run: npm run demo:data`);
      process.exit(1);
    }
    console.log('Demo files are up to date.');
  } else {
    mkdirSync(DEMO_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(DEMO_DIR, name), content);
    for (const [name, a] of Object.entries(manifest.accounts)) {
      console.log(`${name.padEnd(26)} ${String(a.rows).padStart(5)} rows   out ${dollars(a.outCents).padStart(12)}   in ${dollars(a.inCents).padStart(12)}`);
    }
    const az = manifest.amazon;
    console.log(`${DEMO_AMAZON_FILE.padEnd(26)} ${String(az.orders).padStart(5)} orders face value ${dollars(az.faceValueCents)}, ${az.cancelled} cancelled, ${az.chargedToAmex} on Amex`);
    const lowest = manifest.accounts['schwab-checking.csv'].lowestBalanceCents;
    console.log(`Checking balance low point: ${lowest < 0 ? '-' : ''}${dollars(lowest)}${lowest < 0 ? '  <-- overdrawn, raise the opening balance' : ''}`);
    console.log(`${manifest.totalRows} rows in all, written to ${DEMO_DIR}`);
  }
}
