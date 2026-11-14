/**
 * Settings: categories, rules, and the data controls.
 *
 * Rules are shown in match order with the learned ones marked, because the
 * value of a deterministic rules engine is lost if you cannot see what it is
 * doing. "Re-run rules" applies changes to existing rows, and says how many it
 * left alone because they were categorized by hand.
 */

import { useMemo, useState } from 'react';
import { deleteRule as removeRule } from '@/lib/db';
import { describeRule } from '@/categorize/engine';
import { randomId } from '@/lib/ids';
import type { Category, Rule, RuleMatcher } from '@/types/models';
import { useStore } from '../store';
import { DataTransfer } from '../components/DataTransfer';
import type { Filters } from '@/lib/filter';

export function SettingsRoute({ filters }: { filters: Filters }) {
  const {
    rules,
    categories,
    transactions,
    settings,
    workspace,
    saveRules,
    saveCategory,
    saveSettings,
    rerunRules,
    refresh,
    switchWorkspace,
    resetDemo,
    clearMyData,
  } = useStore();
  const [rerunResult, setRerunResult] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState('');
  const [showAllRules, setShowAllRules] = useState(false);

  // Learned rules first: they are the ones the user made and will want to edit.
  const ordered = useMemo(() => {
    const sorted = [...rules].sort((a, b) => a.order - b.order);
    return showAllRules ? sorted : sorted.filter((r) => r.learned || !r.note);
  }, [rules, showAllRules]);

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of transactions) {
      if (!t.categoryId) continue;
      counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [transactions]);

  const moveRule = async (rule: Rule, delta: number) => {
    const sorted = [...rules].sort((a, b) => a.order - b.order);
    const index = sorted.findIndex((r) => r.id === rule.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    const a = sorted[index]!;
    const b = sorted[target]!;
    await saveRules([
      { ...a, order: b.order },
      { ...b, order: a.order },
    ]);
  };

  return (
    <div className="stack">
      <div>
        <h1>Settings</h1>
        <p className="subtitle">Categories, rules, and how your data is handled.</p>
      </div>

      <section className="card">
        <h2>Which data</h2>
        <p className="dim">
          Your own data and the demo household are kept in separate databases. Rules, categories and
          anything you confirm in one never appear in the other.
        </p>
        <div className="workspace-choice" role="radiogroup" aria-label="Which data">
          <label className="radio">
            <input
              type="radio"
              name="workspace"
              checked={workspace === 'real'}
              onChange={() => void switchWorkspace('real')}
            />
            <span>
              <strong>Your data</strong>
              <span className="dim"> — what you import yourself</span>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="workspace"
              checked={workspace === 'demo'}
              onChange={() => void switchWorkspace('demo')}
            />
            <span>
              <strong>Demo household</strong>
              <span className="dim"> — a made-up family of five and their 2025</span>
            </span>
          </label>
        </div>
        {workspace === 'demo' && (
          <div className="actions left">
            <ConfirmButton
              label="Reset demo data"
              question="Reset the demo household? Everything you changed in the demo is discarded. Your own data is not affected."
              confirmLabel="Yes, reset the demo"
              onConfirm={() => void resetDemo()}
            />
          </div>
        )}
      </section>

      <section className="card">
        <h2>Categorization rules</h2>
        <p className="dim">
          Rules are checked in order and the first match wins. A category you set by hand always beats
          a rule, and re-running rules never touches those rows.
        </p>

        <div className="actions left">
          <button
            className="primary"
            onClick={async () => {
              const { changed, skippedManual } = await rerunRules();
              setRerunResult(
                `${changed} ${changed === 1 ? 'transaction' : 'transactions'} recategorized` +
                  (skippedManual > 0 ? ` · ${skippedManual} left alone because you set them by hand` : ''),
              );
            }}
          >
            Re-run rules on all transactions
          </button>
          <label className="checkbox">
            <input type="checkbox" checked={showAllRules} onChange={(e) => setShowAllRules(e.target.checked)} />
            Show the {rules.length - ordered.length} starter rules too
          </label>
        </div>

        {rerunResult && <div className="callout ok">{rerunResult}</div>}

        {ordered.length === 0 ? (
          <p className="dim">
            No rules of your own yet. Set a category on a transaction and you will be offered one.
          </p>
        ) : (
          <table className="preview">
            <thead>
              <tr>
                <th>Order</th>
                <th>Rule</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ordered.map((rule) => (
                <tr key={rule.id} className={rule.enabled ? '' : 'muted'}>
                  <td className="num dim">{rule.order}</td>
                  <td>{describeRule(rule, categories)}</td>
                  <td className="dim">{rule.learned ? 'You created this' : 'Starter rule'}</td>
                  <td className="right nowrap">
                    <button onClick={() => void moveRule(rule, -1)} aria-label="Move up">
                      ↑
                    </button>
                    <button onClick={() => void moveRule(rule, 1)} aria-label="Move down">
                      ↓
                    </button>
                    <button onClick={() => void saveRules([{ ...rule, enabled: !rule.enabled }])}>
                      {rule.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={async () => {
                        await removeRule(rule.id);
                        await refresh();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Categories</h2>
        <div className="chips">
          {categories.map((c) => (
            <CategoryChip key={c.id} category={c} count={usage.get(c.id) ?? 0} onSave={saveCategory} />
          ))}
        </div>
        <div className="actions left">
          <input
            className="grow"
            placeholder="New category name"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newCategory.trim()) {
                void saveCategory({ id: randomId('cat'), name: newCategory.trim(), color: '#8c8c9e' });
                setNewCategory('');
              }
            }}
          />
          <button
            className="primary"
            disabled={!newCategory.trim()}
            onClick={() => {
              void saveCategory({ id: randomId('cat'), name: newCategory.trim(), color: '#8c8c9e' });
              setNewCategory('');
            }}
          >
            Add category
          </button>
        </div>
      </section>

      <section className="card">
        <h2>This install</h2>
        <label className="field">
          <span>Whose data is this?</span>
          <input
            value={settings.profileLabel}
            onChange={(e) => void saveSettings({ ...settings, profileLabel: e.target.value })}
          />
        </label>
        <p className="dim">
          Written into exports so that when two installs are merged, each row still says where it came
          from.
        </p>
      </section>

      <DataTransfer filters={filters} />

      <section className="card">
        <h2>Your data</h2>
        <p className="dim">
          Everything lives in this browser profile on this computer. Nothing is uploaded, there is no
          account, and no part of this extension talks to a server. Amazon access is requested only at
          the moment you run an Amazon import, and can be revoked at any time from
          chrome://extensions.
        </p>

        <h3 className="danger-heading">Delete all data</h3>
        {workspace === 'real' ? (
          <>
            <p className="dim">
              Removes every transaction you imported, along with your rules, categories, confirmed
              matches, saved file layouts and import history. The starter categories and rules come
              back. This cannot be undone, so save a backup above first if you might want any of it
              again. The demo household is not affected.
            </p>
            <div className="actions left">
              <ConfirmButton
                danger
                label="Delete all my data"
                question={`Delete all your data? This removes ${transactions.length.toLocaleString()} ${
                  transactions.length === 1 ? 'transaction' : 'transactions'
                } and every rule, category and match you made. It cannot be undone.`}
                confirmLabel="Yes, delete everything"
                onConfirm={() => void clearMyData()}
              />
            </div>
          </>
        ) : (
          <p className="dim">
            You are looking at the demo household. Use <strong>Reset demo data</strong> at the top of
            this page to start the demo over, or switch to your data to delete what you imported.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * A button that asks before it acts, in the page itself.
 *
 * Not `window.confirm`: a browser driven by automation (including this
 * project's own `npm run chromium` window) dismisses native dialogs on its
 * own, which would silently turn the button into one that never works.
 */
function ConfirmButton({
  label,
  question,
  confirmLabel,
  danger = false,
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button className={danger ? 'danger' : undefined} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }

  return (
    <div className={`confirm-box ${danger ? 'danger' : ''}`} role="alertdialog" aria-label={label}>
      <p>{question}</p>
      <div className="actions left">
        <button
          className={danger ? 'danger solid' : 'primary'}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button autoFocus onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CategoryChip({
  category,
  count,
  onSave,
}: {
  category: Category;
  count: number;
  onSave: (c: Category) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);

  if (editing) {
    return (
      <span className="chip editing">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name !== category.name) void onSave({ ...category, name: name.trim() });
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setName(category.name);
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }

  return (
    <button className="chip" onClick={() => setEditing(true)} title="Rename">
      <i style={{ background: category.color }} />
      {category.name}
      {count > 0 && <span className="chip-count">{count}</span>}
    </button>
  );
}

export type { RuleMatcher };
