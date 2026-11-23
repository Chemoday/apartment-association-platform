import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource-variable/material-symbols-outlined'
import App from './App.vue'
import router from './router/index.js'
import { ensureLocaleLoaded, i18n, readStoredLocale } from './locales/index.js'
import { lastTraceId } from './api/client.js'
import { handleVitePreloadError, reportError } from './utils/telemetry.js'
import './index.css'

const app = createApp(App)
const pinia = createPinia()

app.config.errorHandler = (err, _instance, info) => {
  reportError(err, {
    source: 'vue:errorHandler',
    routeName: String(router.currentRoute.value?.name || ''),
    traceId: lastTraceId.value || '',
    extra: { lifecycleHook: String(info || '') },
  })
}

if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event?.reason, {
      source: 'window:unhandledrejection',
      routeName: String(router.currentRoute.value?.name || ''),
      traceId: lastTraceId.value || '',
    })
  })

  window.addEventListener('vite:preloadError', (event) => {
    handleVitePreloadError(event)
  })
}

app.use(pinia)
app.use(i18n)
app.use(router)

ensureLocaleLoaded(readStoredLocale())
  .catch(() => {})
  .finally(() => {
    app.mount('#app')
  })

