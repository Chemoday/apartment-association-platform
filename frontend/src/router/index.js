import { createRouter, createWebHistory } from 'vue-router'
import { APP_ROUTES } from './routes.js'
import { useSessionStore } from '@/stores/session.js'
import { stashLinkToken } from '@/utils/linkToken.js'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    ...APP_ROUTES,
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
  scrollBehavior(to, _from, savedPosition) {
    if (to.hash) {
      return { el: to.hash, behavior: 'smooth' }
    }
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

router.beforeEach(async (to) => {
  // 1. Magic sign-in link & one-click unsubscribe: extract token from URL fragment immediately and strip hash
  if ((to.name === 'login-link' || to.name === 'unsubscribe') && to.hash && to.hash.length > 1) {
    stashLinkToken(to.hash.slice(1))
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState(null, '', to.path)
    }
    return { name: to.name, hash: '', replace: true }
  }

  // 2. Bootstrap session once per page load
  const session = useSessionStore()
  await session.bootstrap()

  // 3. Public pages are always allowed
  if (to.meta?.public) return true

  // 4. Everything else requires a signed-in user or a demo user (unless backend offline modal is active)
  if (session.authMode === 'none' && !session.backendOffline) {
    return { name: 'welcome' }
  }

  return true
})

export default router
