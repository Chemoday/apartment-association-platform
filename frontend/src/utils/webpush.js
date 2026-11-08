import {
  deleteBinding,
  getVapidPublicKey,
  subscribeWebPush,
} from '@/api/endpoints/notifications.js'
import { base64UrlToUint8Array, bufferToBase64Url } from './base64url.js'

export const BINDING_KEY = 'webpush_binding_id'

export function getStoredWebPushBindingId() {
  try {
    return localStorage.getItem(BINDING_KEY) || ''
  } catch {
    return ''
  }
}

export function detectBrowserDeviceLabel() {
  if (typeof navigator === 'undefined') return 'Browser'
  const ua = navigator.userAgent || ''
  let browser = 'Browser'
  if (ua.includes('Edg/')) browser = 'Edge'
  else if (ua.includes('Chrome/')) browser = 'Chrome'
  else if (ua.includes('Firefox/')) browser = 'Firefox'
  else if (ua.includes('Safari/')) browser = 'Safari'

  let os = 'Desktop'
  if (/Android/i.test(ua)) os = 'Android'
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS'
  else if (/Mac OS X/i.test(ua)) os = 'macOS'
  else if (/Windows/i.test(ua)) os = 'Windows'
  else if (/Linux/i.test(ua)) os = 'Linux'

  return `${browser} on ${os}`.slice(0, 100)
}

export function isWebPushSupportedInBrowser() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const hasApis =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const isSecure =
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  return hasApis && isSecure
}

export async function enableBrowserPush(label = detectBrowserDeviceLabel()) {
  if (!isWebPushSupportedInBrowser()) {
    return { ok: false, reason: 'unsupported' }
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: 'denied' }

  const registration = await navigator.serviceWorker.register('/sw.js')
  const { public_key } = await getVapidPublicKey()
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(public_key),
  })
  const binding = await subscribeWebPush(subscription.toJSON(), label)
  try {
    localStorage.setItem(BINDING_KEY, binding.binding_id)
  } catch {
    /* private mode */
  }
  return { ok: true, binding }
}

export async function removeThisBrowserPush() {
  let bindingId = ''
  try {
    bindingId = localStorage.getItem(BINDING_KEY) || ''
  } catch {
    /* ignore */
  }
  if (bindingId) {
    try {
      await deleteBinding(bindingId)
    } catch (error) {
      if (error?.status !== 404) throw error
    }
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/')
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) await subscription.unsubscribe()
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(BINDING_KEY)
  } catch {
    /* ignore */
  }
}

export async function resubscribeExistingPushAfterSignIn() {
  if (!isWebPushSupportedInBrowser()) return
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) {
      const binding = await subscribeWebPush(
        subscription.toJSON(),
        detectBrowserDeviceLabel(),
      )
      try {
        localStorage.setItem(BINDING_KEY, binding.binding_id)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* channel disabled in demo mode or offline */
  }
}

export async function verifyOrRotateWebPushSubscription(label = detectBrowserDeviceLabel()) {
  if (!isWebPushSupportedInBrowser()) return
  try {
    const registration = await navigator.serviceWorker.getRegistration('/')
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription && subscription.options?.applicationServerKey) {
      const { public_key } = await getVapidPublicKey()
      const current = bufferToBase64Url(subscription.options.applicationServerKey)
      if (current !== public_key) {
        await removeThisBrowserPush()
        await enableBrowserPush(label)
      }
    }
  } catch {
    /* ignore if channel not enabled */
  }
}
