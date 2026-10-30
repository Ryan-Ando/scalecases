import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'

const NICHE_TITLES = { term: 'Scale Cases · Term Life', fex: 'Scale Cases · Final Expense' }

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const niche = (loadEnv(mode, '.', 'VITE_').VITE_NICHE || 'law').toLowerCase()
  return {
    plugins: [
      react(),
      // The insurance niche builds (VITE_NICHE=term | fex) get their own browser-tab title
      { name: 'niche-title', transformIndexHtml: html => NICHE_TITLES[niche] ? html.replace('<title>Scale Cases</title>', `<title>${NICHE_TITLES[niche]}</title>`) : html },
    ],
  }
})
