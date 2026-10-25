import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null }

/**
 * The last line of defence: an error no component handled replaces the page
 * with a way out instead of a blank window. A part of the app that failed to
 * download after an update lands here too, and Reload fetches the new one.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="notfound" role="alert" data-testid="app-error">
        <h1>This page stopped working</h1>
        <p>Reload it to carry on. If it happens again, the details below help whoever runs this server.</p>
        <button className="btn btn--primary" onClick={() => window.location.reload()} data-testid="app-error-reload">Reload</button>
        <details className="notfound__details">
          <summary>Details</summary>
          <code>{error.message || String(error)}</code>
        </details>
      </main>
    );
  }
}
