import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCHEMA_DTS_PATH = join(ROOT_DIR, 'src', 'api', 'schema.d.ts')

const OPENAPI_PATH = process.env.OPENAPI_PATH
  ? resolve(process.env.OPENAPI_PATH)
  : join(ROOT_DIR, 'docs', 'openapi.json')

if (!existsSync(OPENAPI_PATH)) {
  const msg = `OpenAPI schema file not found at ${OPENAPI_PATH}; skipping OpenAPI drift check.`
  if (process.env.REQUIRE_OPENAPI_CHECK === '1' || process.env.OPENAPI_PATH) {
    console.error(`Error: ${msg}`)
    process.exit(1)
  }
  console.warn(`Warning: ${msg}`)
  process.exit(0)
}

const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'))
if (!openapi?.openapi || !openapi?.components?.schemas) {
  console.error(`Invalid ${OPENAPI_PATH}: missing openapi version or components.schemas.`)
  process.exit(1)
}

const dtsSource = readFileSync(SCHEMA_DTS_PATH, 'utf8')
const exportedDecls = new Map()
for (const match of dtsSource.matchAll(/^export\s+(type|interface)\s+(\w+)\b/gm)) {
  exportedDecls.set(match[2], match.index ?? 0)
}

const sortedDeclStarts = [...exportedDecls.entries()].sort((a, b) => a[1] - b[1])

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function getDeclBlock(name) {
  const idx = sortedDeclStarts.findIndex(([n]) => n === name)
  if (idx === -1) return ''
  const start = sortedDeclStarts[idx][1]
  const end = idx + 1 < sortedDeclStarts.length ? sortedDeclStarts[idx + 1][1] : dtsSource.length
  return stripComments(dtsSource.slice(start, end))
}

function collectReferencedTypes(block) {
  const refs = new Set()
  for (const m of block.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
    if (exportedDecls.has(m[1])) {
      refs.add(m[1])
    }
  }
  return refs
}

function collectEnumLiterals(typeName, visited = new Set()) {
  if (visited.has(typeName)) return new Set()
  visited.add(typeName)
  const block = getDeclBlock(typeName)
  const literals = new Set()
  for (const m of block.matchAll(/['"]([^'"]+)['"]/g)) {
    literals.add(m[1])
  }
  for (const refName of collectReferencedTypes(block)) {
    if (refName !== typeName) {
      for (const lit of collectEnumLiterals(refName, visited)) {
        literals.add(lit)
      }
    }
  }
  return literals
}

function collectObjectProperties(typeName, visited = new Set()) {
  if (visited.has(typeName)) return new Set()
  visited.add(typeName)
  const block = getDeclBlock(typeName)
  const props = new Set()

  // Match TypeScript interface/type property identifiers (`propName?:` or `'prop-name'?:`)
  for (const m of block.matchAll(/^\s*(?:readonly\s+)?['"]?([A-Za-z0-9_.-]+)['"]?\s*\??\s*:/gm)) {
    props.add(m[1])
  }

  // Follow type aliases (`export type A = B & { ... }`) or `interface A extends B`
  for (const refName of collectReferencedTypes(block)) {
    if (refName !== typeName) {
      for (const p of collectObjectProperties(refName, visited)) {
        props.add(p)
      }
    }
  }
  return props
}

function collectOpenApiProperties(schemaDef, allSchemas, visited = new Set()) {
  if (!schemaDef || typeof schemaDef !== 'object') return new Map()
  const props = new Map()
  if (schemaDef.properties && typeof schemaDef.properties === 'object') {
    for (const [k, v] of Object.entries(schemaDef.properties)) {
      props.set(k, v)
    }
  }
  for (const combiner of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(schemaDef[combiner])) {
      for (const sub of schemaDef[combiner]) {
        if (sub?.$ref && typeof sub.$ref === 'string') {
          const refName = sub.$ref.split('/').pop()
          if (refName && !visited.has(refName) && allSchemas[refName]) {
            visited.add(refName)
            for (const [k, v] of collectOpenApiProperties(allSchemas[refName], allSchemas, visited)) {
              props.set(k, v)
            }
          }
        } else if (sub && typeof sub === 'object') {
          for (const [k, v] of collectOpenApiProperties(sub, allSchemas, visited)) {
            props.set(k, v)
          }
        }
      }
    }
  }
  return props
}

const schemas = openapi.components.schemas
const schemaNames = Object.keys(schemas).sort()
const missingSchemas = []
const enumDrifts = []
const propertyDrifts = []
let totalPropertiesChecked = 0

for (const name of schemaNames) {
  if (!exportedDecls.has(name)) {
    missingSchemas.push(name)
    continue
  }
  const def = schemas[name]
  if (Array.isArray(def?.enum)) {
    const literals = collectEnumLiterals(name)
    const missingValues = def.enum.filter((v) => !literals.has(String(v)))
    if (missingValues.length > 0) {
      enumDrifts.push({ name, missingValues })
    }
  }

  const expectedProps = collectOpenApiProperties(def, schemas)
  if (expectedProps.size > 0) {
    const actualProps = collectObjectProperties(name)
    const missingProps = []
    for (const [propName, propDef] of expectedProps.entries()) {
      totalPropertiesChecked += 1
      if (!actualProps.has(propName)) {
        missingProps.push(propName)
      }
      if (Array.isArray(propDef?.enum)) {
        const literals = collectEnumLiterals(name)
        const missingEnumVals = propDef.enum.filter((v) => !literals.has(String(v)))
        if (missingEnumVals.length > 0) {
          enumDrifts.push({ name: `${name}.${propName}`, missingValues: missingEnumVals })
        }
      }
    }
    if (missingProps.length > 0) {
      propertyDrifts.push({ name, missingProps })
    }
  }
}

if (missingSchemas.length > 0 || enumDrifts.length > 0 || propertyDrifts.length > 0) {
  console.error('OpenAPI schema drift detected between docs/openapi.json and src/api/schema.d.ts:')
  if (missingSchemas.length > 0) {
    console.error(`  Missing exported schemas (${missingSchemas.length}): ${missingSchemas.join(', ')}`)
  }
  for (const drift of propertyDrifts) {
    console.error(`  Property drift in ${drift.name}: missing properties [${drift.missingProps.join(', ')}]`)
  }
  for (const drift of enumDrifts) {
    console.error(`  Enum drift in ${drift.name}: missing values [${drift.missingValues.join(', ')}]`)
  }
  process.exit(1)
}

console.log(
  `OpenAPI schema check passed: ${schemaNames.length}/${schemaNames.length} schemas, ${totalPropertiesChecked} properties, and all enums verified against src/api/schema.d.ts.`,
)
