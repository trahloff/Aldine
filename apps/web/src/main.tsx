import React, { lazy, Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useNavigate, useParams } from 'react-router-dom';
import { keepShareLink, useShareLinkJoin } from './util/shareLink';
import Home from './pages/Home';
import { BASE_PATH } from './basePath';
import { ToastProvider } from './components/Toast';
import { DialogProvider } from './components/Dialogs';
import { AuthProvider, GuestScope, useAuth } from './components/Auth';
import ErrorBoundary from './components/ErrorBoundary';
import { startThemeSync } from './theme';
// before the router: the editor's Back/Forward guard must hear a popstate first
import './editor/leaveGuard';
import { useDocumentTitle } from './util/documentTitle';
import { projectOfPath } from './util/projectResume';
import './theme.css';
import './app.css';
import './home.css';

// The editor brings CodeMirror, pdf.js, KaTeX and Yjs, most of the app's
// code: the project list must not wait for it.
const loadEditor = () => import('./pages/Editor');
const Editor = lazy(loadEditor);
const OAuthConsent = lazy(() => import('./pages/OAuthConsent'));
const Admin = lazy(() => import('./pages/Admin'));
const Invite = lazy(() => import('./pages/Invite'));

/** One editor per project: from one project straight to another, nothing of the
 *  first (its tree, its open file, its connections) carries over. */
function ProjectEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  // A share link's token leaves the address bar before anything loads, so
  // it is neither bookmarked nor sent on as a referrer.
  const [linkRest] = useState(() => keepShareLink(id, window.location));
  useEffect(() => { if (linkRest !== null) navigate(linkRest, { replace: true }); }, [linkRest]);
  const { guest } = useAuth();
  const join = useShareLinkJoin(id, guest?.projectId === id);
  if (!join.ready) return <div className="editor-shell" />;
  return <Editor key={id} linkProblem={join.problem} />;
}

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

// A share link pasted over its own project's open page changes only the
// fragment, and the browser loads nothing: the page loads again for it.
window.addEventListener('hashchange', () => {
  const path = window.location.pathname;
  const id = path.startsWith(BASE_PATH) ? projectOfPath(path.slice(BASE_PATH.length) || '/') : null;
  if (id && keepShareLink(id, window.location) !== null) window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
       <DialogProvider>
        <AuthProvider>
          <BrowserRouter basename={BASE_PATH} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Suspense fallback={<div className="page-loading" />}>
             <GuestScope>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/p/:id" element={<ProjectEditor />} />
                <Route path="/oauth/authorize" element={<OAuthConsent />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/invite/:id" element={<Invite />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
             </GuestScope>
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
