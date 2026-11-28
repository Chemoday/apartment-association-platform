import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyTheme,
  DEFAULT_THEME_ID,
  getCycledTokens,
  getRotatedSwatches,
  getThemePreset,
  normalizeCycleIndex,
  SWATCH_CYCLE_COUNT,
  THEME_CATEGORIES,
  THEME_CYCLE_MODES,
  THEME_PRESETS,
} from './theme.js'

function hexLuminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = hexLuminance(hexA)
  const l2 = hexLuminance(hexB)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

test('provides exactly 40 curated color palette presets across 6 categories', () => {
  assert.equal(THEME_PRESETS.length, 40)
  assert.ok(THEME_CATEGORIES.length >= 7)

  const ids = new Set(THEME_PRESETS.map((p) => p.id))
  assert.equal(ids.size, 40)

  for (const preset of THEME_PRESETS) {
    assert.equal(preset.swatches.length, 4)
    assert.match(preset.tokens['--color-surface'], /^#[0-9a-fA-F]{6}$/)
    assert.match(preset.tokens['--color-primary'], /^#[0-9a-fA-F]{6}$/)
    assert.match(preset.tokens['--color-secondary'], /^#[0-9a-fA-F]{6}$/)
    assert.match(preset.tokens['--color-on-surface'], /^#[0-9a-fA-F]{6}$/)
  }
})

test('default Warm Nordic theme meets WCAG AA contrast (>= 4.5:1) and stays synced with src/index.css', () => {
  const preset = getThemePreset(DEFAULT_THEME_ID)
  assert.equal(preset.id, 'default')
  assert.equal(preset.name, 'Warm Nordic')

  const t = preset.tokens
  const aaPairs: Array<[string, string, string]> = [
    ['on-surface / surface', t['--color-on-surface'], t['--color-surface']],
    ['on-surface / surface-container-low', t['--color-on-surface'], t['--color-surface-container-low']],
    ['on-surface / surface-container', t['--color-on-surface'], t['--color-surface-container']],
    ['on-surface / surface-container-lowest', t['--color-on-surface'], t['--color-surface-container-lowest']],
    ['on-surface-variant / surface', t['--color-on-surface-variant'], t['--color-surface']],
    ['on-surface-variant / surface-container-low', t['--color-on-surface-variant'], t['--color-surface-container-low']],
    ['on-surface-variant / surface-container', t['--color-on-surface-variant'], t['--color-surface-container']],
    ['on-surface-variant / surface-container-lowest', t['--color-on-surface-variant'], t['--color-surface-container-lowest']],
    ['on-primary / primary', t['--color-on-primary'], t['--color-primary']],
    ['on-primary-container / primary-container', t['--color-on-primary-container'], t['--color-primary-container']],
    ['on-primary-fixed / primary-fixed', t['--color-on-primary-fixed'], t['--color-primary-fixed']],
    ['on-secondary / secondary', t['--color-on-secondary'], t['--color-secondary']],
    ['on-secondary-container / secondary-container', t['--color-on-secondary-container'], t['--color-secondary-container']],
    ['on-error / error', t['--color-on-error'], t['--color-error']],
    ['on-error-container / error-container', t['--color-on-error-container'], t['--color-error-container']],
    ['inverse-on-surface / inverse-surface', t['--color-inverse-on-surface'], t['--color-inverse-surface']],
  ]

  for (const [label, fg, bg] of aaPairs) {
    const ratio = contrastRatio(fg, bg)
    assert.ok(
      ratio >= 4.5,
      `Expected WCAG AA contrast >= 4.5:1 for ${label} (${fg} on ${bg}), got ${ratio.toFixed(2)}:1`,
    )
  }

  // Verify ALL --color-* tokens in src/index.css @theme stay 100% in sync with THEME_PRESETS[0]
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  const cssColorMatches = Array.from(css.matchAll(/^\s*(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/gm))
  assert.ok(cssColorMatches.length >= 40, `Expected >= 40 --color-* tokens in src/index.css, found ${cssColorMatches.length}`)
  for (const [, tokenName, cssValue] of cssColorMatches) {
    assert.equal(
      t[tokenName]?.toLowerCase(),
      cssValue.toLowerCase(),
      `Token mismatch for ${tokenName}: src/index.css has ${cssValue}, THEME_PRESETS[0] has ${t[tokenName]}`,
    )
  }
  assert.ok(
    css.includes('@custom-variant dark (&:where([data-theme-mode="dark"], [data-theme-mode="dark"] *));'),
    'Expected src/index.css to scope Tailwind dark: variant to data-theme-mode="dark" so OS dark mode never washes out light themes',
  )
  assert.ok(
    css.includes('--font-headline-xl: "Source Serif 4"'),
    'Expected src/index.css to use self-hosted Source Serif 4 for editorial headlines',
  )
})

test('getThemePreset and applyTheme resolve valid presets and fall back to default', () => {
  const applied = applyTheme('warm-sand', 0)
  assert.equal(applied, 'warm-sand')

  const fallback = getThemePreset('non-existent-id')
  assert.equal(fallback.id, DEFAULT_THEME_ID)
})

test('getRotatedSwatches and getCycledTokens cyclically permute only the 4 colors of a single preset', () => {
  assert.equal(SWATCH_CYCLE_COUNT, 4)
  assert.equal(THEME_CYCLE_MODES.length, 4)
  assert.equal(normalizeCycleIndex(4), 0)
  assert.equal(normalizeCycleIndex(-1), 3)

  const preset = getThemePreset('warm-sand')
  const [c0, c1, c2, c3] = preset.swatches

  assert.deepEqual(getRotatedSwatches(preset, 0), [c0, c1, c2, c3])
  assert.deepEqual(getRotatedSwatches(preset, 1), [c1, c2, c3, c0])
  assert.deepEqual(getRotatedSwatches(preset, 2), [c2, c3, c0, c1])
  assert.deepEqual(getRotatedSwatches(preset, 3), [c3, c0, c1, c2])
  assert.deepEqual(getRotatedSwatches(preset, 4), [c0, c1, c2, c3])

  const tokens1 = getCycledTokens(preset, 1)
  assert.equal(tokens1['--color-surface'], c1)
  assert.equal(tokens1['--color-surface-container-lowest'], c2)
  assert.equal(tokens1['--color-primary'], c3)
  assert.equal(tokens1['--color-secondary'], c0)

  const tokens2 = getCycledTokens(preset, 2)
  assert.equal(tokens2['--color-surface'], c2)
  assert.equal(tokens2['--color-surface-container-lowest'], c3)
  assert.equal(tokens2['--color-primary'], c0)
  assert.equal(tokens2['--color-secondary'], c1)
})
