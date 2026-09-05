import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Home from './pages/Home';
import Editor from './pages/Editor';
import { BASE_PATH } from './basePath';

function NotFound() {
  return (
    <div className="notfound">
      <h1>Page not found</h1>
      <p>That page doesn’t exist.</p>
      <Link className="btn btn--primary" to="/">Back to your projects</Link>
    </div>
  );
}
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './components/Auth';
import './theme.css';
import './app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter basename={BASE_PATH} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/p/:id" element={<Editor />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  </React.StrictMode>,
);
