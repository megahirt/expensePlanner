import { useState } from 'react';
import { StoreProvider, useStore } from './store';
import { ImportRoute } from './routes/Import';

const ROUTES = ['Dashboard', 'Transactions', 'Import', 'Review', 'Settings'] as const;
export type Route = (typeof ROUTES)[number];

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>('Import');
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
      <main className="main">{ready ? <RouteView route={route} /> : <Loading />}</main>
    </div>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route) {
    case 'Import':
      return <ImportRoute />;
    default:
      return (
        <div className="card empty">
          <h2>{route}</h2>
          <p>Coming together in the next phase.</p>
        </div>
      );
  }
}

function Loading() {
  return (
    <div className="card empty">
      <p className="dim">Opening your data…</p>
    </div>
  );
}
