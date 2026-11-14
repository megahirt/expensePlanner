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
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  clearAllData,
  countTransactions,
  getActiveWorkspace,
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
  setActiveWorkspace,
  setCategoryForMany,
  undoImportBatch,
  updateUserFields,
  WORKSPACE_KEY,
  type UserEditableFields,
  type Workspace,
} from '@/lib/db';
import { loadDemoData } from '@/lib/demo';
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
  /** Which set of data every screen is showing: the user's own, or the demo. */
  workspace: Workspace;
  /** Set when a switch could not be completed, e.g. the demo files failed to load. */
  workspaceError: string | null;
  /** A one-line confirmation of the last wholesale change, e.g. a deletion. */
  notice: string | null;
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
  /** Show the other set of data. The demo is loaded the first time it is opened. */
  switchWorkspace: (workspace: Workspace) => Promise<void>;
  /** Throw away the demo household and load it fresh. Never touches real data. */
  resetDemo: () => Promise<void>;
  /**
   * Delete everything the user imported and decided: transactions, rules,
   * categories, matches, saved mappings and settings. The starter categories
   * and rules come back. Never touches the demo.
   */
  clearMyData: () => Promise<void>;
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

/** `?workspace=demo` on the page address opens straight into the demo. */
function requestedWorkspace(): Workspace | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const asked = url.searchParams.get('workspace');
  if (asked !== 'demo' && asked !== 'real') return null;
  // Honour it once: left in the address, a reload would undo a later switch.
  url.searchParams.delete('workspace');
  window.history.replaceState(null, '', url);
  return asked;
}

const EMPTY: StoreState = {
  ready: false,
  workspace: getActiveWorkspace(),
  workspaceError: null,
  notice: null,
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
    setState((prev) => ({
      ready: true,
      workspace: getActiveWorkspace(),
      workspaceError: prev.workspaceError,
      notice: prev.notice,
      transactions,
      categories,
      rules,
      sources,
      batches,
      links,
      settings,
    }));
  }, []);

  // Switches run one at a time. Two overlapping ones could otherwise leave the
  // screen showing one set of data while writes go to the other.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const open = useCallback(
    (workspace: Workspace, opts: { wipe?: boolean } = {}) => {
      const run = async () => {
        setState((prev) => ({ ...prev, ready: false, workspace, workspaceError: null, notice: null }));
        try {
          await setActiveWorkspace(workspace);
          // The one place data is wiped wholesale. It runs after the switch
          // above, so it can only ever empty the workspace that was asked for.
          if (opts.wipe && getActiveWorkspace() === workspace) await clearAllData();

          // Seed only a genuinely empty database, so a user who deleted a
          // builtin category does not find it resurrected on the next launch.
          if (needsSeeding(await getCategories())) {
            await putCategories(DEFAULT_CATEGORIES);
            await putRules(defaultRules());
          }
          if (workspace === 'demo' && (await countTransactions()) === 0) await loadDemoData();
          await refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (workspace === 'demo') {
            // Fall back to the user's own data rather than a half-loaded demo.
            await setActiveWorkspace('real');
            await refresh();
          }
          setState((prev) => ({ ...prev, ready: true, workspaceError: message }));
        }
      };
      queue.current = queue.current.then(run, run);
      return queue.current;
    },
    [refresh],
  );

  useEffect(() => {
    void open(requestedWorkspace() ?? getActiveWorkspace());

    // Another tab of the app switched: follow it, so this tab cannot carry on
    // writing to a database its banner no longer describes.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== WORKSPACE_KEY) return;
      const next: Workspace = event.newValue === 'demo' ? 'demo' : 'real';
      if (next !== getActiveWorkspace()) void open(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [open]);

  const actions = useMemo<StoreActions>(
    () => ({
      refresh,
      switchWorkspace: (workspace) => open(workspace),
      resetDemo: async () => {
        if (getActiveWorkspace() !== 'demo') return;
        await open('demo', { wipe: true });
        setState((prev) => ({ ...prev, notice: 'The demo household has been reset.' }));
      },
      clearMyData: async () => {
        if (getActiveWorkspace() !== 'real') return;
        await open('real', { wipe: true });
        setState((prev) => ({ ...prev, notice: 'All your data has been deleted.' }));
      },
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
    [refresh, open],
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
