/**
 * Telling words.
 *
 * Two small word lists, both matched on whole words only:
 *
 * - MERCHANT_WORDS: words in a business's own name that say what it is. No list
 *   of brands will ever include "Bright Smiles Orthodontics" or "Greenwood Auto
 *   Repair", but their names give them away.
 * - ITEM_WORDS: words in a product name, used to say what an Amazon order was
 *   actually for instead of filing every order under Shopping.
 *
 * Words are kept only if they are hard to misread. "Market" is not here
 * (stock market, Marketplace, farmers market, supermarket are all different
 * things); "orthodontics" is.
 */

import { findPhrase, words } from './text';

type Table = ReadonlyArray<readonly [string, readonly string[]]>;

const MERCHANT_WORDS: Table = [
  ['cat-home', ['mortgage', 'home loan', 'hoa', 'homeowners association', 'property tax', 'property management',
    'apartments', 'rent payment', 'leasing']],
  ['cat-utilities', ['energy', 'electric', 'power', 'utilities', 'utility', 'water', 'sewer', 'wireless',
    'telecom', 'broadband', 'internet', 'insurance', 'garbage', 'sanitation', 'natural gas']],
  ['cat-transport', ['auto repair', 'auto body', 'auto parts', 'automotive', 'tires', 'lube', 'oil change',
    'tolls', 'toll', 'parking', 'vehicle licensing', 'licensing', 'towing', 'car wash', 'ferries', 'ferry',
    'transit', 'motor vehicles', 'toyota financial', 'honda financial', 'ford credit', 'auto loan',
    'smog', 'collision']],
  ['cat-health', ['dental', 'dentist', 'dentistry', 'orthodontics', 'orthodontist', 'pediatric', 'pediatrics',
    'clinic', 'medical', 'hospital', 'pharmacy', 'optical', 'optometry', 'eye care', 'dermatology',
    'chiropractic', 'physical therapy', 'urgent care', 'copay', 'health', 'therapy', 'counseling',
    'labs', 'radiology', 'gym', 'yoga', 'pilates']],
  ['cat-kids', ['school', 'schools', 'schoolpay', 'elementary', 'preschool', 'daycare', 'childcare',
    'child care', 'after school', 'summer camp', 'day camp', 'tutoring', 'youth soccer', 'youth', 'little league',
    'pta', 'book fairs', 'college savings', 'tuition', 'swim lessons', 'lessons', 'academy', 'montessori',
    'scouts', 'gymnastics', 'kids']],
  ['cat-dining', ['restaurant', 'cafe', 'coffee', 'pizza', 'pizzeria', 'grill', 'diner', 'bistro', 'tacos',
    'taqueria', 'sushi', 'bakery', 'brewing', 'brewery', 'cantina', 'bbq', 'burger', 'burgers', 'gelato',
    'ice cream', 'drive in', 'noodle', 'ramen', 'pho', 'tavern', 'steakhouse', 'creamery', 'donuts',
    'bagels', 'espresso', 'eatery', 'teriyaki', 'thai', 'fish co', 'chophouse', 'trattoria', 'gastropub']],
  ['cat-groceries', ['farmers market', 'food market', 'grocery', 'grocer', 'supermarket', 'foods', 'produce',
    'butcher', 'co op']],
  ['cat-entertainment', ['cinema', 'cinemas', 'theatre', 'theater', 'movies', 'zoo', 'museum', 'aquarium',
    'science center', 'roller rink', 'bowling', 'arcade', 'adventure park', 'trampoline park', 'theme park',
    'legoland', 'disneyland', 'concert', 'tickets', 'eshop', 'golf', 'ski', 'lanes']],
  ['cat-travel', ['airlines', 'airways', 'hotel', 'hotels', 'resort', 'motel', 'lodge', 'rent a car',
    'car rental', 'airbnb', 'vrbo', 'cruise', 'cruises', 'amtrak', 'hostel', 'suites']],
  ['cat-gifts', ['donation', 'donations', 'charity', 'foundation', 'food bank', 'church', 'ministries',
    'red cross', 'gofundme', 'florist', 'flowers']],
  ['cat-fees', ['fee', 'fees', 'interest charge', 'finance charge', 'overdraft']],
  ['cat-household', ['hardware', 'home improvement', 'furniture', 'cleaners', 'laundry', 'lawn', 'landscaping',
    'plumbing', 'pest control', 'veterinary', 'animal hospital', 'pet', 'pets', 'locksmith', 'roofing',
    'heating', 'appliance']],
];

/** Read only when money came in, so "interest" on a loan statement is not income. */
const INCOME_WORDS: Table = [
  ['cat-income', ['payroll', 'direct dep', 'direct deposit', 'salary', 'tax ref', 'tax refund', 'interest paid',
    'dividend', 'bonus', 'cashback', 'cash back', 'reimbursement']],
];

const ITEM_WORDS: Table = [
  ['cat-household', ['paper towels', 'toilet paper', 'detergent', 'dishwasher', 'trash bags', 'storage bags',
    'batteries', 'light bulbs', 'bulbs', 'filter', 'filters', 'hand soap', 'soap', 'extension cord',
    'storage bins', 'vacuum', 'skillet', 'baking', 'hose', 'bird seed', 'garden', 'dog food', 'cat food',
    'cat litter', 'dog', 'pet', 'poop bags', 'string lights', 'organizer', 'lamp', 'lantern', 'cleaner',
    'sponges', 'towels', 'tomato cage', 'cookware', 'pillow', 'sheets', 'curtains', 'tool', 'tools']],
  ['cat-groceries', ['coffee', 'granola', 'snacks', 'fruit snacks', 'cereal', 'tea', 'pasta', 'protein bars',
    'coffee filters', 'bars']],
  ['cat-kids', ['kids', 'kid', 'toddler', 'childrens', 'youth', 'baby', 'lego', 'plush', 'squishmallow',
    'crayola', 'markers', 'crayons', 'notebooks', 'pencils', 'backpack', 'lunch box', 'picture book',
    'chapter book', 'graphic novel', 'toy', 'toys', 'scooter', 'soccer', 'costume', 'building kit',
    'diapers', 'stroller']],
  ['cat-health', ['vitamin', 'vitamins', 'multivitamin', 'bandages', 'toothpaste', 'sunscreen', 'first aid',
    'thermometer', 'supplement', 'yoga mat']],
  ['cat-entertainment', ['board game', 'puzzle', 'card game', 'video game', 'blu ray']],
  ['cat-transport', ['car phone mount', 'windshield', 'wipers', 'motor oil', 'tire', 'car seat cover']],
  ['cat-gifts', ['birthday', 'party supplies', 'wrapping paper', 'gift', 'greeting cards']],
];

export interface WordMatch {
  categoryId: string;
  /** The word or phrase that decided it. */
  word: string;
}

/** Categorize a merchant by a telling word in its name. */
export function categoryFromMerchantName(merchant: string, amountCents: number): WordMatch | null {
  const w = words(merchant);
  if (amountCents > 0) {
    const income = findPhrase(w, INCOME_WORDS);
    if (income) return { categoryId: income.value, word: income.phrase };
  }
  const hit = findPhrase(w, MERCHANT_WORDS);
  return hit ? { categoryId: hit.value, word: hit.phrase } : null;
}

/** Categorize a single product by a telling word in its name. */
export function categoryFromItemName(name: string): WordMatch | null {
  const hit = findPhrase(words(name), ITEM_WORDS);
  return hit ? { categoryId: hit.value, word: hit.phrase } : null;
}

export interface ItemsMatch {
  categoryId: string;
  /** The item that carried the decision. */
  itemName: string;
}

/**
 * Categorize an order by what it mostly contained.
 *
 * Each recognised item votes with its price. The winner only counts if it
 * accounts for at least half the order by value, so a $6 pack of batteries does
 * not decide the category of an order that was mostly a $90 keyboard.
 */
export function categoryFromItems(
  items: ReadonlyArray<{ name: string; amountCents: number; quantity?: number }>,
): ItemsMatch | null {
  const votes = new Map<string, { cents: number; itemName: string; biggest: number }>();
  let total = 0;
  for (const item of items) {
    const cents = Math.max(item.amountCents, 1) * Math.max(item.quantity ?? 1, 1);
    total += cents;
    const hit = categoryFromItemName(item.name);
    if (!hit) continue;
    const vote = votes.get(hit.categoryId) ?? { cents: 0, itemName: item.name, biggest: 0 };
    vote.cents += cents;
    if (cents > vote.biggest) {
      vote.biggest = cents;
      vote.itemName = item.name;
    }
    votes.set(hit.categoryId, vote);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1].cents - a[1].cents)[0];
  if (!winner || winner[1].cents * 2 < total) return null;
  return { categoryId: winner[0], itemName: winner[1].itemName };
}
