import test from 'node:test'
import assert from 'node:assert/strict'
import { APP_ROUTES, NAV_GROUPS } from '../../router/routes.js'
import { createClientVueViteServer } from '../../test/mountWithApp.js'

test('AppIcon maps every route and nav group icon to a concrete Tabler Icons component', async () => {
  const vite = await createClientVueViteServer()
  try {
    const mod = await vite.ssrLoadModule('/src/components/base/AppIcon.vue')
    const iconMap = mod.APP_ICON_MAP as Record<string, unknown>
    assert.ok(iconMap && typeof iconMap === 'object', 'APP_ICON_MAP must be exported')

    for (const group of NAV_GROUPS) {
      assert.ok(
        iconMap[group.icon],
        `Missing Tabler icon mapping in APP_ICON_MAP for NAV_GROUPS "${group.id}" icon "${group.icon}"`,
      )
    }

    for (const route of APP_ROUTES) {
      const iconName = route.meta?.icon
      if (iconName) {
        assert.ok(
          iconMap[iconName],
          `Missing Tabler icon mapping in APP_ICON_MAP for route "${String(route.name)}" icon "${iconName}"`,
        )
      }
    }
  } finally {
    await vite.close()
  }
})
