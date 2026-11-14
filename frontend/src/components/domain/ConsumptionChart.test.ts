import assert from 'node:assert/strict'
import test from 'node:test'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPinia } from 'pinia'
import { createServer, type ViteDevServer } from 'vite'

async function renderChart({
  vite,
  lang = 'en',
  props = {},
}: {
  vite: ViteDevServer
  lang?: string
  props?: Record<string, any>
}) {
  const { useSessionStore } = await vite.ssrLoadModule('/src/stores/session.js')
  const { default: ConsumptionChart } = await vite.ssrLoadModule(
    '/src/components/domain/ConsumptionChart.vue',
  )

  const pinia = createPinia()
  const app = createSSRApp({ render: () => h(ConsumptionChart, props) })
  app.use(pinia)

  const session = useSessionStore(pinia)
  await session.setLang(lang)

  return renderToString(app)
}

test('ConsumptionChart.vue renders confirmed, estimated, gap, open-month, negative, error, and localized states (#030)', async () => {
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  })

  try {
    const periods = [
      { period_code: '2026-08', status: 'LOCKED' },
      { period_code: '2026-09', status: 'LOCKED' },
      { period_code: '2026-10', status: 'LOCKED' },
      { period_code: '2026-11', status: 'OPEN_FOR_RESIDENTS' },
    ]
    const series = [
      {
        resource_type: 'COLD_WATER',
        unit: 'm3',
        months: [
          { period_code: '2026-08', consumption: '4.125', estimated: true },
          { period_code: '2026-09', consumption: '-0.500', estimated: false },
          { period_code: '2026-10', consumption: null, estimated: false },
          { period_code: '2026-11', consumption: '2.000', estimated: false },
        ],
      },
      {
        resource_type: 'HOT_WATER',
        unit: 'm3',
        months: [
          { period_code: '2026-08', consumption: '3.000', estimated: false },
          { period_code: '2026-09', consumption: '3.100', estimated: false },
          { period_code: '2026-10', consumption: '3.200', estimated: false },
          { period_code: '2026-11', consumption: null, estimated: false },
        ],
      },
    ]

    const htmlEn = await renderChart({
      vite,
      lang: 'en',
      props: { periods, series },
    })

    assert.equal(htmlEn.includes('data-testid="consumption-chart-card-COLD_WATER"'), true)
    assert.equal(htmlEn.includes('data-testid="consumption-chart-card-HOT_WATER"'), true)
    assert.equal(htmlEn.includes('data-testid="chart-bar-COLD_WATER-2026-08"'), true)
    assert.equal(htmlEn.includes('data-testid="chart-bar-COLD_WATER-2026-10"'), true)
    assert.equal(htmlEn.includes('data-testid="chart-bar-COLD_WATER-2026-11"'), true)
    assert.equal(htmlEn.includes('Estimated'), true)
    assert.equal(htmlEn.includes('No reading'), true)
    assert.equal(htmlEn.includes('In progress'), true)
    assert.equal(htmlEn.includes('4.125 m³'), true)
    assert.equal(htmlEn.includes('-0.500 m³'), true)

    assert.equal(htmlEn.includes('aria-pressed="false"'), true)
    assert.equal(htmlEn.includes('bar-focus-ring'), true)

    // 24-month window uses sectionTitleMonths and wide Y values expand plotLeft cleanly
    const periods24 = Array.from({ length: 24 }, (_, idx) => {
      const year = 2025 + Math.floor(idx / 12)
      const month = String((idx % 12) + 1).padStart(2, '0')
      return { period_code: `${year}-${month}`, status: idx === 23 ? 'OPEN_FOR_RESIDENTS' : 'LOCKED' }
    })
    const html24 = await renderChart({
      vite,
      lang: 'en',
      props: {
        months: 24,
        periods: periods24,
        series: [
          {
            resource_type: 'ELECTRICITY',
            unit: 'kWh',
            months: periods24.map((p) => ({
              period_code: p.period_code,
              consumption: '1234.567',
              estimated: false,
            })),
          },
        ],
      },
    })
    assert.equal(html24.includes('Last 24 months'), true)
    assert.equal(html24.includes('01/25'), true)
    assert.equal(html24.includes('12/26'), true)

    // Estonian & Russian localization
    const htmlEt = await renderChart({
      vite,
      lang: 'et',
      props: { periods, series },
    })
    assert.equal(htmlEt.includes('Hinnanguline'), true)
    assert.equal(htmlEt.includes('Pooleli'), true)

    const htmlRu = await renderChart({
      vite,
      lang: 'ru',
      props: { periods, series },
    })
    assert.equal(htmlRu.includes('Расчётное'), true)
    assert.equal(htmlRu.includes('В процессе'), true)

    // Loading skeleton
    const htmlLoading = await renderChart({
      vite,
      lang: 'en',
      props: { periods: [], series: [], loading: true },
    })
    assert.equal(htmlLoading.includes('data-testid="consumption-chart-loading"'), true)

    // Error card
    const htmlError = await renderChart({
      vite,
      lang: 'en',
      props: { periods: [], series: [], error: { status: 500, message: 'Server error' } },
    })
    assert.equal(htmlError.includes('data-testid="consumption-chart-error"'), true)

    // Empty state
    const htmlEmpty = await renderChart({
      vite,
      lang: 'en',
      props: { periods, series: [] },
    })
    assert.equal(htmlEmpty.includes('data-testid="consumption-chart-empty"'), true)
  } finally {
    await vite.close()
  }
})
