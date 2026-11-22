import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { useApp } from './store/app'
import { applyTheme } from './lib/themes'

// Debug handle for automated UI checks (DevTools): window.__centralserver.useApp.getState()
;(window as unknown as { __centralserver: unknown }).__centralserver = { useApp, applyTheme }

// `#gallery` renders the design gallery (every UI element with sample data) for theme QA.
const Gallery = React.lazy(() => import('./pages/Gallery'))
const gallery = window.location.hash === '#gallery'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {gallery ? (
      <React.Suspense fallback={null}>
        <Gallery />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
)
