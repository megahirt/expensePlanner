/**
 * App-wide data layer.
 *
 * The whole dataset is held in memory and refreshed from IndexedDB after every
 * mutation. That is a deliberate simplification: a household's transaction
 * history is tens of thousands of rows at most, which is small enough to filter
 * and aggregate in memory instantly, and it keeps every screen reading from one
 * consistent snapshot instead of each inventing its own queries.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getAllTransactions,
  getCategories,
  getImportBatches,
  getLinks,
  getRules,
  getSettings,
  getSources,
  putCategories,
  putRules,
  putSettings,
  putSource,
  putTransaction,
  setCategoryForMany,
  undoImportBatch,
  updateUserFields,
  type UserEditableFields,
} from '@/lib/db';
import { DEFAULT_CATEGORIES, defaultRules, needsSeeding } from '@/categorize/defaults';
import { proposeRuleFromTransaction, recategorizeAll } from '@/categorize/engine';
import type {
  Category,
  ImportBatch,
  Rule,
  Settings,
  SourceRecord,
  Transaction,
  TransactionLink,
} from '@/types/models';
import { defaultSettings } from '@/types/models';

interface StoreState {
  ready: boolean;
  transactions: Transaction[];
  categories: Category[];
  rules: Rule[];
  sources: SourceRecord[];
  batches: ImportBatch[];
  links: TransactionLink[];
  settings: Settings;
}

interface StoreActions {
  refresh: () => Promise<void>;
  editTransaction: (id: string, patch: Partial<UserEditableFields>) => Promise<void>;
  bulkCategorize: (ids: readonly string[], categoryId: string | null) => Promise<void>;
  /** File every row from a merchant under a category, by creating a rule for it. */
  categorizeMerchant: (merchant: string, categoryId: string) => Promise<void>;
  saveRule: (rule: Rule) => Promise<void>;
  saveRules: (rules: readonly Rule[]) => Promise<void>;
  saveCategory: (category: Category) => Promise<void>;
  saveSource: (source: SourceRecord) => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  undoBatch: (batchId: string) => Promise<void>;
  /** Re-run all rules over rows the user has not categorized by hand. */
  rerunRules: () => Promise<{ changed: number; skippedManual: number }>;
}

type Store = StoreState & StoreActions;

const StoreContext = createContext<Store | null>(null);

const EMPTY: StoreState = {
  ready: false,
  transactions: [],
  categories: [],
  rules: [],
  sources: [],
  batches: [],
  links: [],
  settings: defaultSettings(),
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(EMPTY);

  const refresh = useCallback(async () => {
    const [transactions, categories, rules, sources, batches, links, settings] = await Promise.all([
      getAllTransactions(),
      getCategories(),
      getRules(),
      getSources(),
      getImportBatches(),
      getLinks(),
      getSettings(),
    ]);
    setState({ ready: true, transactions, categories, rules, sources, batches, links, settings });
  }, []);

  useEffect(() => {
    void (async () => {
      // Seed only a genuinely empty database, so a user who deleted a builtin
      // category does not find it resurrected on the next launch.
      const existing = await getCategories();
      if (needsSeeding(existing)) {
        await putCategories(DEFAULT_CATEGORIES);
        await putRules(defaultRules());
      }
      await refresh();
    })();
  }, [refresh]);

  const actions = useMemo<StoreActions>(
    () => ({
      refresh,
      editTransaction: async (id, patch) => {
        await updateUserFields(id, patch);
        await refresh();
      },
      bulkCategorize: async (ids, categoryId) => {
        await setCategoryForMany(ids, categoryId);
        await refresh();
      },
      categorizeMerchant: async (merchant, categoryId) => {
        const [transactions, rules, categories] = await Promise.all([
          getAllTransactions(),
          getRules(),
          getCategories(),
        ]);
        const order = rules.reduce((max, r) => Math.max(max, r.order), 0) + 1;
        const rule = proposeRuleFromTransaction({ merchant }, categoryId, order, `rule-learned-${Date.now()}`);
        await putRules([rule]);
        const { changed } = recategorizeAll(transactions, [...rules, rule], categories);
        for (const t of changed) await putTransaction(t);
        await refresh();
      },
      saveRule: async (rule) => {
        await putRules([rule]);
        await refresh();
      },
      saveRules: async (rules) => {
        await putRules(rules);
        await refresh();
      },
      saveCategory: async (category) => {
        await putCategories([category]);
        await refresh();
      },
      saveSource: async (source) => {
        await putSource(source);
        await refresh();
      },
      saveSettings: async (settings) => {
        await putSettings(settings);
        await refresh();
      },
      undoBatch: async (batchId) => {
        await undoImportBatch(batchId);
        await refresh();
      },
      rerunRules: async () => {
        const [transactions, rules, categories] = await Promise.all([
          getAllTransactions(),
          getRules(),
          getCategories(),
        ]);
        const { changed, categoryChanges, skippedManual } = recategorizeAll(transactions, rules, categories);
        // Written directly: these are decisions about rows already held, and a
        // row that has just lost its category must be able to say so.
        for (const t of changed) await putTransaction(t);
        await refresh();
        return { changed: categoryChanges, skippedManual };
      },
    }),
    [refresh],
  );

  const value = useMemo<Store>(() => ({ ...state, ...actions }), [state, actions]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}

/** Category lookup by id, memoized for table rendering. */
export function useCategoryMap(): Map<string, Category> {
  const { categories } = useStore();
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
}
