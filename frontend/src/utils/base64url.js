/**
 * Convert a base64url-encoded string (e.g. VAPID public key) into a Uint8Array.
 * @param {string} value
 * @returns {Uint8Array}
 */
export function base64UrlToUint8Array(value) {
  const padded = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(value || '').length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

/**
 * Convert an ArrayBuffer or Uint8Array into a padding-free base64url string.
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {string}
 */
export function bufferToBase64Url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
