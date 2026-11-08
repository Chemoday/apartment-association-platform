import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  activeDemoUserId,
  applySession,
  clearSession,
  refreshSession,
  setDemoUser,
  setSessionEndedHandler,
  signedIn,
} from '@/api/client.js'
import { enableOfflineDemo, isOfflineDemoMode } from '@/api/offlineDemoData.js'
import { logout } from '@/api/endpoints/auth.js'
import { getDemoUsers } from '@/api/endpoints/demo.js'
import { getBuilding, getMe, updateLocale, updatePrivacy } from '@/api/endpoints/property.js'
import { i18n, readStoredLocale, setI18nLocale, SUPPORTED_LOCALES } from '@/locales/index.js'
import {
  applyTheme,
  DEFAULT_CYCLE_INDEX,
  normalizeCycleIndex,
  readStoredTheme,
  readStoredThemeCyclesMap,
  THEME_CYCLE_MODES,
  THEME_PRESETS,
  writeStoredThemeCyclesMap,
} from '@/utils/theme.js'
import {
  removeThisBrowserPush,
  resubscribeExistingPushAfterSignIn,
  verifyOrRotateWebPushSubscription,
} from '@/utils/webpush.js'

export const RECONNECT_INTERVAL_MS = 10000
const RECONNECT_TICK_MS = 100

let bootPromise = null

export const useSessionStore = defineStore('session', () => {
  const demoUsers = ref([])
  const demoUsersLoaded = ref(false)
  const demoUsersError = ref(null)

  const backendOffline = ref(false)
  const offlineDemoMode = computed(() => isOfflineDemoMode.value)
  const retryCountdownMs = ref(RECONNECT_INTERVAL_MS)
  const retryingBackend = ref(false)
  let reconnectTimerId = null

  const me = ref(null)
  const building = ref(null)
  const meLoading = ref(false)
  const meError = ref(null)

  const selectedApartmentId = ref('')
  const lang = ref(setI18nLocale(readStoredLocale()))
  const themeCycles = ref(readStoredThemeCyclesMap())
  const initialThemeId = readStoredTheme()
  const theme = ref(
    applyTheme(initialThemeId, themeCycles.value[initialThemeId] ?? DEFAULT_CYCLE_INDEX),
  )
  const themeCycle = computed(() =>
    normalizeCycleIndex(themeCycles.value[theme.value] ?? DEFAULT_CYCLE_INDEX),
  )
  const sessionRevision = ref(0)
  const sessionEndedReason = ref('')

  const authMode = computed(() =>
    signedIn.value ? 'signed_in' : activeDemoUserId.value ? 'demo' : 'none',
  )
  const isSignedIn = computed(() => signedIn.value)

  const actingUserId = computed(() =>
    signedIn.value ? me.value?.user_id || '' : activeDemoUserId.value,
  )
  const activeUserId = computed(() => actingUserId.value)
  const locale = computed(() => lang.value)

  const currentDemoUser = computed(
    () => demoUsers.value.find((u) => u.user_id === actingUserId.value) || null,
  )

  const buildingRole = computed(
    () => me.value?.building_role || currentDemoUser.value?.building_role || 'USER',
  )

  const notificationLocale = computed(() => me.value?.locale ?? null)

  const memberships = computed(() => me.value?.memberships || [])

  const activeMembership = computed(() => {
    if (!memberships.value.length) return null
    return (
      memberships.value.find((m) => m.apartment_id === selectedApartmentId.value) ||
      memberships.value[0]
    )
  })

  // Building metadata derived from GET /api/v1/property/building
  const buildingName = computed(() => building.value?.name || 'KÜ Sõpruse 12')
  const buildingRegistryCode = computed(() => building.value?.registry_code || '80123456')
  const buildingAddress = computed(
    () => building.value?.address || 'Sõpruse pst 12, Kristiine, Tallinn',
  )
  const buildingApartmentsCount = computed(
    () =>
      building.value?.apartment_count ??
      building.value?.apartments_count ??
      building.value?.total_apartments ??
      36,
  )
  const buildingEntrancesCount = computed(
    () =>
      building.value?.entrance_count ??
      building.value?.entrances_count ??
      building.value?.total_entrances ??
      2,
  )
  const buildingHeatedArea = computed(
    () =>
      building.value?.heated_area_m2 ??
      building.value?.heated_area ??
      building.value?.total_area_m2 ??
      '329.20',
  )

  function setLang(newLang) {
    const valid = setI18nLocale(newLang)
    lang.value = valid
  }

  function getPresetCycle(presetId) {
    return normalizeCycleIndex(themeCycles.value[presetId] ?? DEFAULT_CYCLE_INDEX)
  }

  function setTheme(newThemeId) {
    const cycleForTarget = getPresetCycle(newThemeId)
    theme.value = applyTheme(newThemeId, cycleForTarget)
  }

  function setThemeCycle(cycleIndex, targetThemeId = theme.value) {
    const normalized = normalizeCycleIndex(cycleIndex)
    themeCycles.value = {
      ...themeCycles.value,
      [targetThemeId]: normalized,
    }
    writeStoredThemeCyclesMap(themeCycles.value)
    if (targetThemeId === theme.value) {
      applyTheme(theme.value, normalized)
    }
  }

  function cycleTheme(step = 1, targetThemeId = theme.value) {
    const current = getPresetCycle(targetThemeId)
    const next = normalizeCycleIndex(current + step)
    themeCycles.value = {
      ...themeCycles.value,
      [targetThemeId]: next,
    }
    writeStoredThemeCyclesMap(themeCycles.value)
    theme.value = applyTheme(targetThemeId, next)
  }

  function resetAllThemeCycles() {
    themeCycles.value = {}
    writeStoredThemeCyclesMap({})
  }

  function t(key, params = {}) {
    const current = lang.value
    return i18n.global.t(key, params, { locale: current })
  }

  function selectApartment(apartmentId) {
    selectedApartmentId.value = apartmentId
  }

  async function loadDemoUsers() {
    demoUsersError.value = null
    try {
      const list = await getDemoUsers()
      demoUsers.value = Array.isArray(list) ? list : []
      demoUsersLoaded.value = true

      if (!signedIn.value && demoUsers.value.length > 0) {
        const currentValid = demoUsers.value.some((u) => u.user_id === activeDemoUserId.value)
        if (!activeDemoUserId.value || !currentValid) {
          const apt14 =
            demoUsers.value.find((u) => u.apartment_number === '14') || demoUsers.value[0]
          setDemoUser(apt14.user_id)
        }
      }
      return demoUsers.value
    } catch (error) {
      demoUsersError.value = error
      demoUsersLoaded.value = true
      return []
    }
  }

  async function loadMe() {
    if (!signedIn.value && !activeDemoUserId.value) {
      me.value = null
      building.value = null
      return null
    }
    meLoading.value = true
    meError.value = null
    try {
      const [meData, buildingData] = await Promise.all([
        getMe(),
        getBuilding().catch(() => null),
      ])
      me.value = meData
      if (buildingData) {
        building.value = buildingData
      }
      if (meData.memberships?.length) {
        const stillValid = meData.memberships.some(
          (m) => m.apartment_id === selectedApartmentId.value,
        )
        if (!stillValid) {
          selectedApartmentId.value = meData.memberships[0].apartment_id
        }
      } else {
        selectedApartmentId.value = ''
      }
      verifyOrRotateWebPushSubscription().catch(() => {})
      return meData
    } catch (error) {
      me.value = null
      meError.value = error
      if (error?.status === 401 && !signedIn.value) {
        setDemoUser('')
      }
      return null
    } finally {
      meLoading.value = false
    }
  }

  function stopReconnectLoop() {
    if (reconnectTimerId !== null && typeof window !== 'undefined') {
      window.clearInterval(reconnectTimerId)
      reconnectTimerId = null
    }
    retryingBackend.value = false
  }

  function startReconnectLoop() {
    if (isOfflineDemoMode.value) {
      stopReconnectLoop()
      return
    }
    if (reconnectTimerId !== null || typeof window === 'undefined') return
    retryCountdownMs.value = RECONNECT_INTERVAL_MS
    reconnectTimerId = window.setInterval(() => {
      if (isOfflineDemoMode.value || !backendOffline.value) {
        stopReconnectLoop()
        return
      }
      if (retryingBackend.value) return
      const next = retryCountdownMs.value - RECONNECT_TICK_MS
      if (next <= 0) {
        retryCountdownMs.value = 0
        retryBackendNow()
      } else {
        retryCountdownMs.value = next
      }
    }, RECONNECT_TICK_MS)
  }

  async function retryBackendNow() {
    if (isOfflineDemoMode.value || retryingBackend.value) return
    retryingBackend.value = true
    try {
      await loadDemoUsers()
      if (!demoUsersError.value && demoUsers.value.length > 0) {
        if (signedIn.value || activeDemoUserId.value) {
          await loadMe()
        }
        if (!meError.value?.isBackendUnavailable) {
          backendOffline.value = false
          stopReconnectLoop()
          sessionRevision.value += 1
          return true
        }
      }
      retryCountdownMs.value = RECONNECT_INTERVAL_MS
      return false
    } finally {
      retryingBackend.value = false
    }
  }

  async function activateOfflineDemoMode() {
    stopReconnectLoop()
    enableOfflineDemo()
    backendOffline.value = false
    demoUsersError.value = null
    meError.value = null
    demoUsersLoaded.value = false
    await loadDemoUsers()
    await loadMe()
    sessionRevision.value += 1
  }

  async function initializeSession() {
    if (!demoUsersLoaded.value) {
      await loadDemoUsers()
    }
    if ((signedIn.value || activeDemoUserId.value) && !me.value && !demoUsersError.value) {
      await loadMe()
    }

    if (!isOfflineDemoMode.value && !signedIn.value) {
      const unreachable =
        Boolean(demoUsersError.value) ||
        Boolean(meError.value?.isBackendUnavailable) ||
        demoUsers.value.length === 0
      if (unreachable) {
        backendOffline.value = true
        startReconnectLoop()
      } else {
        backendOffline.value = false
        stopReconnectLoop()
      }
    }
  }

  function bootstrap() {
    if (!bootPromise) {
      bootPromise = (async () => {
        let signed = false
        try {
          signed = await refreshSession()
        } catch {
          signed = false
        }
        if (signed) {
          await loadMe()
          demoUsersLoaded.value = true
        } else {
          await initializeSession()
        }
      })()
    }
    return bootPromise
  }

  function resetAfterSessionEnd() {
    clearSession()
    setDemoUser('')
    me.value = null
    building.value = null
    selectedApartmentId.value = ''
    sessionRevision.value += 1
  }

  async function completeSignIn(sessionResponse) {
    applySession(sessionResponse)
    setDemoUser('')
    sessionEndedReason.value = ''
    me.value = null
    selectedApartmentId.value = ''
    sessionRevision.value += 1
    await loadMe()
    resubscribeExistingPushAfterSignIn().catch(() => {})
  }

  async function signOut() {
    await removeThisBrowserPush().catch(() => {})
    try {
      await logout()
    } catch {
      /* offline: still forget the session locally */
    }
    resetAfterSessionEnd()
  }

  function clearSessionEndedReason() {
    sessionEndedReason.value = ''
  }

  setSessionEndedHandler((reason) => {
    resetAfterSessionEnd()
    sessionEndedReason.value = reason
    import('@/router/index.js')
      .then((mod) => {
        mod.default.push({ name: 'welcome' })
      })
      .catch(() => {})
  })

  async function switchUser(userId) {
    if (signedIn.value) return
    if (!userId) {
      me.value = null
      building.value = null
      selectedApartmentId.value = ''
      setDemoUser('')
      sessionRevision.value += 1
      return
    }
    me.value = null
    selectedApartmentId.value = ''
    setDemoUser(userId)
    sessionRevision.value += 1
    await loadMe()
  }

  async function changePrivacyMode(membershipId, privacyDisplayMode) {
    const updated = await updatePrivacy(membershipId, privacyDisplayMode)
    if (me.value && Array.isArray(me.value.memberships)) {
      me.value = {
        ...me.value,
        privacy_display_mode: updated.privacy_display_mode,
        memberships: me.value.memberships.map((m) =>
          m.membership_id === membershipId
            ? {
                ...m,
                privacy_display_mode: updated.privacy_display_mode,
                preview_badge: updated.preview_badge,
              }
            : m,
        ),
      }
    }
    sessionRevision.value += 1
    return updated
  }

  async function changeNotificationLocale(newLocale) {
    const updated = await updateLocale(newLocale)
    if (me.value) {
      me.value = {
        ...me.value,
        locale: updated.locale ?? null,
      }
    }
    return updated
  }

  /**
   * 1-click demo helper to acquire a real Bearer session for the current demo role
   * (or a preferred building role such as 'CHAIRMAN').
   * @param {string} [preferredRole]
   */
  async function signInAsDemoRole(preferredRole = '') {
    let targetUserId = actingUserId.value
    if (preferredRole && demoUsers.value.length > 0) {
      const matched = demoUsers.value.find((u) => u.building_role === preferredRole)
      if (matched) {
        targetUserId = matched.user_id
      }
    }
    if (!targetUserId && demoUsers.value.length > 0) {
      targetUserId = demoUsers.value[0].user_id
    }
    const token = targetUserId ? `demo-user-${targetUserId}` : 'demo-valid-token'
    const { redeemLink } = await import('@/api/endpoints/auth.js')
    const res = await redeemLink(token)
    if (res?.status === 'SIGNED_IN' && res.session) {
      await completeSignIn(res.session)
      return true
    }
    return false
  }

  return {
    demoUsers,
    demoUsersLoaded,
    demoUsersError,
    backendOffline,
    offlineDemoMode,
    retryCountdownMs,
    retryingBackend,
    me,
    building,
    buildingName,
    buildingRegistryCode,
    buildingAddress,
    buildingApartmentsCount,
    buildingEntrancesCount,
    buildingHeatedArea,
    meLoading,
    meError,
    authMode,
    isSignedIn,
    sessionEndedReason,
    actingUserId,
    activeUserId,
    currentDemoUser,
    buildingRole,
    notificationLocale,
    memberships,
    activeMembership,
    selectedApartmentId,
    lang,
    locale,
    supportedLocales: SUPPORTED_LOCALES,
    theme,
    themeCycle,
    themeCycles,
    themeCycleModes: THEME_CYCLE_MODES,
    themePresets: THEME_PRESETS,
    sessionRevision,
    setLang,
    getPresetCycle,
    setTheme,
    setThemeCycle,
    cycleTheme,
    resetAllThemeCycles,
    t,
    selectApartment,
    loadDemoUsers,
    loadMe,
    initializeSession,
    bootstrap,
    completeSignIn,
    signOut,
     signInAsDemoRole,
    resetAfterSessionEnd,
    clearSessionEndedReason,
    retryBackendNow,
    activateOfflineDemoMode,
    stopReconnectLoop,
    switchUser,
    changePrivacyMode,
    changeNotificationLocale,
  }
})
