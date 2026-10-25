import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home';
import { BASE_PATH } from './basePath';
import { ToastProvider } from './components/Toast';
import { DialogProvider } from './components/Dialogs';
import { AuthProvider } from './components/Auth';
import ErrorBoundary from './components/ErrorBoundary';
import { startThemeSync } from './theme';
import { useDocumentTitle } from './util/documentTitle';
import './theme.css';
import './app.css';

// The editor brings CodeMirror, pdf.js, KaTeX and Yjs, most of the app's
// code: the project list must not wait for it.
const loadEditor = () => import('./pages/Editor');
const Editor = lazy(loadEditor);
const OAuthConsent = lazy(() => import('./pages/OAuthConsent'));
const Admin = lazy(() => import('./pages/Admin'));

function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <main className="notfound">
      <h1>Page not found</h1>
      <p>That page doesn’t exist.</p>
      <Link className="btn btn--primary" to="/">Back to your projects</Link>
    </main>
  );
}

startThemeSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
       <DialogProvider>
        <AuthProvider>
          <BrowserRouter basename={BASE_PATH} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Suspense fallback={<div className="page-loading" />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/p/:id" element={<Editor />} />
                <Route path="/oauth/authorize" element={<OAuthConsent />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
       </DialogProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// Opening a project is the usual next step: fetch the editor once the page
// has settled, so the first project opens without waiting for it.
const idle = (cb: () => void) => (typeof window.requestIdleCallback === 'function'
  ? window.requestIdleCallback(cb, { timeout: 5000 })
  : window.setTimeout(cb, 1500));
const prefetchEditor = () => idle(() => { loadEditor().catch(() => { /* the route retries when it is visited */ }); });
if (document.readyState === 'complete') prefetchEditor();
else window.addEventListener('load', prefetchEditor, { once: true });
