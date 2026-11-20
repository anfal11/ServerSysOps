import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { useApp } from './store/app'

// Debug handle for automated UI checks (DevTools): window.__servermate.useApp.getState()
;(window as unknown as { __servermate: unknown }).__servermate = { useApp }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
