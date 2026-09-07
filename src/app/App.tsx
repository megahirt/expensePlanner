import { useState } from 'react';

const ROUTES = ['Dashboard', 'Transactions', 'Import', 'Review', 'Settings'] as const;
type Route = (typeof ROUTES)[number];

export function App() {
  const [route, setRoute] = useState<Route>('Dashboard');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          expense<span>Planner</span>
        </div>
        <nav className="nav">
          {ROUTES.map((r) => (
            <button
              key={r}
              onClick={() => setRoute(r)}
              aria-current={route === r ? 'page' : undefined}
            >
              {r}
            </button>
          ))}
        </nav>
        <div className="topbar-right">All data stays on this computer</div>
      </header>
      <main className="main">
        <div className="card empty">
          <h2>{route}</h2>
          <p>Coming together — import and browsing land in the next phases.</p>
        </div>
      </main>
    </div>
  );
}
