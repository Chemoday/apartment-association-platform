import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC_DIR = join(ROOT_DIR, 'src')
const TEST_FILE_RE = /\.test\.(?:ts|js|mts|mjs)$/

function discoverTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      discoverTestFiles(fullPath, acc)
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      acc.push(relative(ROOT_DIR, fullPath))
    }
  }
  return acc
}

function isFileArgument(arg) {
  if (!arg || arg.startsWith('-')) return false
  if (/\.(?:ts|js|mts|mjs)$/.test(arg)) return true
  const resolved = resolve(ROOT_DIR, arg)
  try {
    return existsSync(resolved) && statSync(resolved).isFile()
  } catch {
    return false
  }
}

const cliArgs = process.argv.slice(2)
const hasExplicitFileArgs = cliArgs.some(isFileArgument)
const files = hasExplicitFileArgs ? [] : discoverTestFiles(SRC_DIR).sort()

if (!hasExplicitFileArgs) {
  if (files.length === 0) {
    console.error('No test files found under src/.')
    process.exit(1)
  }
  console.log(`Discovered ${files.length} test files under src/.`)
}

const tsxBin = join(
  ROOT_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
)

const result = spawnSync(tsxBin, ['--test', ...cliArgs, ...files], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
})

if (result.error) {
  console.error('Failed to execute tsx test runner:', result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
