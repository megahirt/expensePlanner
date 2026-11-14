import { useState } from 'react';
import { StoreProvider, useStore } from './store';
import { ImportRoute } from './routes/Import';
import { TransactionsRoute } from './routes/Transactions';
import { SettingsRoute } from './routes/Settings';
import { DashboardRoute } from './routes/Dashboard';
import { ReviewRoute } from './routes/Review';
import { CategorizeRoute } from './routes/Categorize';
import { emptyFilters, type Filters } from '@/lib/filter';

const ROUTES = ['Dashboard', 'Transactions', 'Categorize', 'Import', 'Review', 'Settings'] as const;
export type Route = (typeof ROUTES)[number];

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>('Dashboard');
  // Filters live here rather than inside the table so a chart click on the
  // dashboard can navigate to Transactions with the filter already applied,
  // and the two views can never disagree about what is being shown.
  const [filters, setFilters] = useState<Filters>(emptyFilters());
  const { ready, transactions } = useStore();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          expense<span>Planner</span>
        </div>
        <nav className="nav">
          {ROUTES.map((r) => (
            <button key={r} onClick={() => setRoute(r)} aria-current={route === r ? 'page' : undefined}>
              {r}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {ready && <span>{transactions.length.toLocaleString()} transactions</span>}
          <span>All data stays on this computer</span>
        </div>
      </header>
      <main className="main">
        {ready ? (
          <RouteView route={route} filters={filters} setFilters={setFilters} onNavigate={setRoute} />
        ) : (
          <div className="card empty">
            <p className="dim">Opening your data\u2026</p>
          </div>
        )}
      </main>
    </div>
  );
}

function RouteView({
  route,
  filters,
  setFilters,
  onNavigate,
}: {
  route: Route;
  filters: Filters;
  setFilters: (f: Filters) => void;
  onNavigate: (r: Route) => void;
}) {
  switch (route) {
    case 'Dashboard':
      return (
        <DashboardRoute
          onDrillDown={(next) => {
            setFilters(next);
            onNavigate('Transactions');
          }}
          onCategorize={() => onNavigate('Categorize')}
        />
      );
    case 'Transactions':
      return <TransactionsRoute filters={filters} onFiltersChange={setFilters} />;
    case 'Categorize':
      return (
        <CategorizeRoute
          onDrillDown={(next) => {
            setFilters(next);
            onNavigate('Transactions');
          }}
        />
      );
    case 'Import':
      return <ImportRoute />;
    case 'Review':
      return (
        <ReviewRoute
          onDrillDown={(next) => {
            setFilters(next);
            onNavigate('Transactions');
          }}
        />
      );
    case 'Settings':
      return <SettingsRoute filters={filters} />;
    default:
      return (
        <div className="card empty">
          <h2>{route}</h2>
          <p>Coming together in the next phase.</p>
        </div>
      );
  }
}
