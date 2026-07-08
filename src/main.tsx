import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { PromptProvider } from './components/PromptProvider'
import { ToastProvider } from './components/ToastProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <PromptProvider>
        <App />
      </PromptProvider>
    </ToastProvider>
  </StrictMode>,
)
