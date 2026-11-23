/**
 * Unified mock domain barrel (`src/mocks/domains/index.ts`, #041).
 * Centralizes shared mock domain fixtures, types, and state engines across
 * `src/server/apiMiddleware.ts` and `src/api/offlineDemoData.js`.
 */

export * from './property.js'
export * from './meters.js'
export * from './communication.js'
export * from './governance.js'
export * from './notifications.js'
