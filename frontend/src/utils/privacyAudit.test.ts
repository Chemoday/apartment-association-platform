import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC_DIR = path.resolve(process.cwd(), 'src')

function walkSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'server') continue // server mock middleware is not client bundle
      files.push(...walkSourceFiles(full))
    } else if (
      (entry.name.endsWith('.js') || entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(full)
    }
  }
  return files
}

test('Section 8.2 Privacy Check: Web Storage never stores tokens, emails, or link codes', () => {
  const files = walkSourceFiles(SRC_DIR)
  const forbiddenStoragePatterns = [
    /localStorage\.setItem\([^)]*(token|email|code|refresh|password)/i,
    /sessionStorage\.setItem\([^)]*(token|email|code|refresh|password)/i,
  ]

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    const rel = path.relative(SRC_DIR, file)
    for (const pattern of forbiddenStoragePatterns) {
      assert.equal(
        pattern.test(content),
        false,
        `Forbidden storage key pattern found in ${rel}: ${pattern}`,
      )
    }
  }
})

test('Section 8.2 Privacy Check: console.* never logs tokens, emails, link codes, or subscriptions', () => {
  const files = walkSourceFiles(SRC_DIR)
  const consolePattern = /console\.(log|info|debug|warn|error)\(([^)]*)\)/g
  const sensitiveTerms = /\b(accessToken|access_token|email|link_code|subscription)\b/i

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    const rel = path.relative(SRC_DIR, file)
    let match: RegExpExecArray | null
    while ((match = consolePattern.exec(content)) !== null) {
      const args = match[2] || ''
      assert.equal(
        sensitiveTerms.test(args),
        false,
        `Sensitive value logged to console in ${rel}: ${match[0]}`,
      )
    }
  }
})

test('Section 8.2 Privacy Check: accessToken variable is confined strictly to src/api/client.js', () => {
  const files = walkSourceFiles(SRC_DIR)
  for (const file of files) {
    const rel = path.relative(SRC_DIR, file).replace(/\\/g, '/')
    if (rel === 'api/client.js') continue
    const content = fs.readFileSync(file, 'utf8')
    assert.equal(
      /\baccessToken\b/.test(content),
      false,
      `accessToken must only exist inside api/client.js, but was found in ${rel}`,
    )
  }
})
