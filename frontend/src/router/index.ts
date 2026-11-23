import { createRouter, createWebHistory } from 'vue-router'
import { APP_ROUTES } from './routes.js'
import { createAuthGuard } from './access.js'
import { applyRouteA11yMetadata } from './title.js'
import { useSessionStore } from '@/stores/session.js'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    ...APP_ROUTES,
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/errors/NotFoundView.vue'),
      meta: {
        layout: 'AppLayout',
      },
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

router.beforeEach(createAuthGuard(() => useSessionStore()))

router.afterEach((to, from) => {
  const session = useSessionStore()
  const isSpaTransition = Boolean(from?.name && from.fullPath !== to.fullPath)
  applyRouteA11yMetadata(to, session, { announce: isSpaTransition })

  if (
    isSpaTransition &&
    typeof document !== 'undefined' &&
    typeof requestAnimationFrame === 'function'
  ) {
    requestAnimationFrame(() => {
      const mainEl = document.getElementById('main-content')
      if (mainEl && typeof mainEl.focus === 'function') {
        mainEl.focus({ preventScroll: true })
      }
    })
  }
})

export default router
