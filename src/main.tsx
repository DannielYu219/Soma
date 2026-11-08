import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import App from './App'
import { hydrateState } from './lib/persistence'
import './styles.css'

await hydrateState()
// Apply restored appearance before mounting the UI (the HTML boot script sees only the browser cache).
try {
  const mode = localStorage.getItem('soma-theme')
  document.documentElement.dataset.theme = mode === 'dark' || ((!mode || mode === 'system') && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
} catch { /* System theme is a safe fallback. */ }
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user" transition={{ type: 'spring', stiffness: 320, damping: 38, mass: 1 }}>
      <App />
    </MotionConfig>
  </React.StrictMode>,
)
