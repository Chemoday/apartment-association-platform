import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  activeDemoUserId,
  applySession,
  asApiErrorLike,
  clearSession,
  refreshSession,
  setDemoUser,
  setSessionEndedHandler,
  signedIn,
  type SessionEndedReason,
} from '@/api/client.js'
import type {
  BuildingResponse,
  BuildingRole,
  DemoUserView,
  DisplayMode,
  Locale,
  LocaleUpdate,
  MembershipView,
  MeResponse,
  PrivacyUpdateResponse,
  SessionResponse,
} from '@/api/schema.js'
import { enableOfflineDemoAsync, isOfflineDemoMode } from '@/api/offlineDemoState.js'
import { logout } from '@/api/endpoints/auth.js'
import { getDemoUsers } from '@/api/endpoints/demo.js'
import { getBuilding, getMe, updateLocale, updatePrivacy } from '@/api/endpoints/property.js'
import {
  ensureLocaleLoaded,
  i18n,
  localeMessagesRevision,
  normalizeLocaleCode,
  readStoredLocale,
  setI18nLocale,
  SUPPORTED_LOCALES,
} from '@/locales/index.js'
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
import { appTabSync, type TabSyncEvent } from '@/utils/tabSync.js'
import { clearServerStateCache } from '@/composables/useApiResource.js'

export const RECONNECT_INTERVAL_MS = 10000
const RECONNECT_TICK_MS = 100

export type AuthMode = 'signed_in' | 'demo' | 'none'

export type ExtendedBuildingResponse = BuildingResponse & {
  apartments_count?: number
  total_apartments?: number
  entrances_count?: number
  total_entrances?: number
  heated_area?: string
  total_area_m2?: string
}

let bootPromise: Promise<void> | null = null
let unsubscribeTabSync: (() => void) | null = null

export const useSessionStore = defineStore('session', () => {
  const demoUsers = ref<DemoUserView[]>([])
  const demoUsersLoaded = ref<boolean>(false)
  const demoUsersError = ref<unknown>(null)

  const backendOffline = ref<boolean>(false)
  const offlineDemoMode = computed<boolean>(() => isOfflineDemoMode.value)
  const retryCountdownMs = ref<number>(RECONNECT_INTERVAL_MS)
  const retryingBackend = ref<boolean>(false)
  let reconnectTimerId: number | null = null

  const me = ref<MeResponse | null>(null)
  const building = ref<ExtendedBuildingResponse | null>(null)
  const meLoading = ref<boolean>(false)
  const meError = ref<unknown>(null)
  const buildingLoading = ref<boolean>(false)
  const buildingError = ref<unknown>(null)
  let buildingSeq = 0
  let meSeq = 0
  let meController: AbortController | null = null

  function invalidateMeRequest(): void {
    meSeq += 1
    if (meController) {
      try {
        meController.abort()
      } catch {
        /* ignore */
      }
      meController = null
    }
    meLoading.value = false
  }

  const selectedApartmentId = ref<string>('')
  const lang = ref<Locale>(setI18nLocale(readStoredLocale()) as Locale)
  const themeCycles = ref<Record<string, number>>(
    readStoredThemeCyclesMap() as Record<string, number>,
  )
  const initialThemeId = readStoredTheme()
  const theme = ref<string>(
    applyTheme(initialThemeId, themeCycles.value[initialThemeId] ?? DEFAULT_CYCLE_INDEX),
  )
  const themeCycle = computed<number>(() =>
    normalizeCycleIndex(themeCycles.value[theme.value] ?? DEFAULT_CYCLE_INDEX),
  )
  const sessionRevision = ref<number>(0)
  const sessionEndedReason = ref<SessionEndedReason>('')

  // Centrally wipe all cached server-state queries on every login, logout, 401 expiry, or demo switch (#043)
  watch(
    sessionRevision,
    () => {
      clearServerStateCache()
    },
    { flush: 'sync' },
  )

  const authMode = computed<AuthMode>(() =>
    signedIn.value ? 'signed_in' : activeDemoUserId.value ? 'demo' : 'none',
  )
  const isSignedIn = computed<boolean>(() => signedIn.value)

  const actingUserId = computed<string>(() =>
    signedIn.value ? me.value?.user_id || '' : activeDemoUserId.value,
  )
  const activeUserId = computed<string>(() => actingUserId.value)
  const locale = computed<Locale>(() => lang.value)

  const currentDemoUser = computed<DemoUserView | null>(
    () => demoUsers.value.find((u) => u.user_id === actingUserId.value) || null,
  )

  const buildingRole = computed<BuildingRole>(
    () =>
      (me.value?.building_role ||
        currentDemoUser.value?.building_role ||
        'USER') as BuildingRole,
  )

  const notificationLocale = computed<Locale | null>(() => me.value?.locale ?? null)

  const memberships = computed<MembershipView[]>(() => me.value?.memberships || [])

  const activeMembership = computed<MembershipView | null>(() => {
    if (!memberships.value.length) return null
    return (
      memberships.value.find((m) => m.apartment_id === selectedApartmentId.value) ||
      memberships.value[0]
    )
  })

  // Building metadata derived from GET /api/v1/property/building
  const buildingName = computed<string>(() => building.value?.name || 'KÜ Sõpruse 12')
  const buildingRegistryCode = computed<string>(
    () => building.value?.registry_code || '80123456',
  )
  const buildingAddress = computed<string>(
    () => building.value?.address || 'Sõpruse pst 12, Kristiine, Tallinn',
  )
  const knownBuildingApartmentsCount = computed<number | null>(() => {
    const raw =
      building.value?.apartment_count ??
      building.value?.apartments_count ??
      building.value?.total_apartments ??
      null
    const count = Number(raw)
    return Number.isInteger(count) && count > 0 ? count : null
  })
  const buildingApartmentsCount = computed<number>(
    () => knownBuildingApartmentsCount.value ?? 36,
  )
  const buildingEntrancesCount = computed<number>(
    () =>
      building.value?.entrance_count ??
      building.value?.entrances_count ??
      building.value?.total_entrances ??
      2,
  )
  const buildingHeatedArea = computed<string>(
    () =>
      building.value?.heated_area_m2 ??
      building.value?.heated_area ??
      building.value?.total_area_m2 ??
      '329.20',
  )
  const buildingRegistryFacts = computed<BuildingResponse['registry_facts']>(
    () => building.value?.registry_facts ?? null,
  )

  let localeSwitchSeq = 0

  function setLang(
    newLang: string,
    { broadcast = true }: { broadcast?: boolean } = {},
  ): Promise<Locale> {
    const seq = ++localeSwitchSeq
    const previousLang: Locale = lang.value || 'en'
    const valid = normalizeLocaleCode(newLang) as Locale
    setI18nLocale(valid)
    lang.value = valid
    if (broadcast) {
      appTabSync.broadcast('LOCALE_CHANGED', { lang: valid })
    }
    return ensureLocaleLoaded(valid)
      .then(() => {
        if (seq === localeSwitchSeq) {
          setI18nLocale(valid)
          lang.value = valid
        }
        return lang.value
      })
      .catch(() => {
        // Graceful fallback if the locale chunk failed to download (never throw unhandledrejection)
        if (seq === localeSwitchSeq) {
          const fallback: Locale = previousLang && previousLang !== valid ? previousLang : 'en'
          setI18nLocale(fallback)
          lang.value = fallback
        }
        return lang.value
      })
  }

  function getPresetCycle(presetId: string): number {
    return normalizeCycleIndex(themeCycles.value[presetId] ?? DEFAULT_CYCLE_INDEX)
  }

  function setTheme(
    newThemeId: string,
    { broadcast = true }: { broadcast?: boolean } = {},
  ): void {
    if (!broadcast) {
      themeCycles.value = readStoredThemeCyclesMap() as Record<string, number>
    }
    const cycleForTarget = getPresetCycle(newThemeId)
    const applied = applyTheme(newThemeId, cycleForTarget)
    theme.value = applied
    if (broadcast) {
      appTabSync.broadcast('THEME_CHANGED', { theme: applied })
    }
  }

  function setThemeCycle(
    cycleIndex: number,
    targetThemeId: string = theme.value,
    { broadcast = true }: { broadcast?: boolean } = {},
  ): void {
    const normalized = normalizeCycleIndex(cycleIndex)
    themeCycles.value = {
      ...themeCycles.value,
      [targetThemeId]: normalized,
    }
    writeStoredThemeCyclesMap(themeCycles.value)
    if (targetThemeId === theme.value) {
      applyTheme(theme.value, normalized)
    }
    if (broadcast) {
      appTabSync.broadcast('THEME_CHANGED', { theme: theme.value })
    }
  }

  function cycleTheme(step: number = 1, targetThemeId: string = theme.value): void {
    const current = getPresetCycle(targetThemeId)
    const next = normalizeCycleIndex(current + step)
    themeCycles.value = {
      ...themeCycles.value,
      [targetThemeId]: next,
    }
    writeStoredThemeCyclesMap(themeCycles.value)
    theme.value = applyTheme(targetThemeId, next)
    appTabSync.broadcast('THEME_CHANGED', { theme: theme.value })
  }

  function resetAllThemeCycles(): void {
    themeCycles.value = {}
    writeStoredThemeCyclesMap({})
    theme.value = applyTheme(theme.value, DEFAULT_CYCLE_INDEX)
    appTabSync.broadcast('THEME_CHANGED', { theme: theme.value })
  }

  function t(key: string, params: Record<string, unknown> = {}): string {
    void localeMessagesRevision.value
    const current = lang.value
    return String(i18n.global.t(key, params, { locale: current }))
  }

  function selectApartment(apartmentId: string): void {
    selectedApartmentId.value = apartmentId
  }

  async function loadDemoUsers(): Promise<DemoUserView[]> {
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

  async function loadBuilding(): Promise<ExtendedBuildingResponse | null> {
    const seq = ++buildingSeq
    if (!signedIn.value && !activeDemoUserId.value) {
      building.value = null
      buildingError.value = null
      buildingLoading.value = false
      return null
    }
    buildingLoading.value = true
    buildingError.value = null
    try {
      const buildingData = await getBuilding()
      if (seq !== buildingSeq) return null
      building.value = (buildingData as ExtendedBuildingResponse) || null
      return building.value
    } catch (error) {
      if (seq !== buildingSeq) return null
      building.value = null
      buildingError.value = error
      return null
    } finally {
      if (seq === buildingSeq) {
        buildingLoading.value = false
      }
    }
  }

  async function loadMe(): Promise<MeResponse | null> {
    if (!signedIn.value && !activeDemoUserId.value) {
      invalidateMeRequest()
      me.value = null
      building.value = null
      buildingError.value = null
      ++buildingSeq
      return null
    }
    invalidateMeRequest()
    const seq = ++meSeq
    const controller = new AbortController()
    meController = controller
    meLoading.value = true
    meError.value = null
    try {
      const [meData] = await Promise.all([getMe({ signal: controller.signal }), loadBuilding()])
      if (seq !== meSeq) return null
      me.value = meData
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
    } catch (error: unknown) {
      const errLike = asApiErrorLike(error)
      if (seq !== meSeq || errLike.errorCode === 'REQUEST_ABORTED' || errLike.name === 'AbortError') {
        return null
      }
      me.value = null
      meError.value = error
      if (errLike.status === 401 && !signedIn.value) {
        setDemoUser('')
      }
      return null
    } finally {
      if (seq === meSeq) {
        meLoading.value = false
        meController = null
      }
    }
  }

  function stopReconnectLoop(): void {
    if (reconnectTimerId !== null && typeof window !== 'undefined') {
      window.clearInterval(reconnectTimerId)
      reconnectTimerId = null
    }
    retryingBackend.value = false
  }

  function startReconnectLoop(): void {
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

  async function retryBackendNow(): Promise<boolean | undefined> {
    if (isOfflineDemoMode.value || retryingBackend.value) return
    retryingBackend.value = true
    try {
      await loadDemoUsers()
      if (!demoUsersError.value && demoUsers.value.length > 0) {
        if (signedIn.value || activeDemoUserId.value) {
          await loadMe()
        }
        if (!asApiErrorLike(meError.value).isBackendUnavailable) {
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

  async function activateOfflineDemoMode(): Promise<void> {
    await enableOfflineDemoAsync()
    stopReconnectLoop()
    backendOffline.value = false
    demoUsersError.value = null
    meError.value = null
    demoUsersLoaded.value = false
    await loadDemoUsers()
    await loadMe()
    sessionRevision.value += 1
  }

  async function initializeSession(): Promise<void> {
    if (!demoUsersLoaded.value) {
      await loadDemoUsers()
    }
    if ((signedIn.value || activeDemoUserId.value) && !me.value && !demoUsersError.value) {
      await loadMe()
    }

    if (!isOfflineDemoMode.value && !signedIn.value) {
      const unreachable =
        Boolean(demoUsersError.value) ||
        Boolean(asApiErrorLike(meError.value).isBackendUnavailable) ||
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

  function bootstrap(): Promise<void> {
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

  function resetAfterSessionEnd(): void {
    invalidateMeRequest()
    clearSession()
    setDemoUser('')
    me.value = null
    building.value = null
    buildingError.value = null
    buildingLoading.value = false
    ++buildingSeq
    selectedApartmentId.value = ''
    sessionRevision.value += 1
  }

  async function completeSignIn(sessionResponse: SessionResponse): Promise<void> {
    invalidateMeRequest()
    applySession(sessionResponse)
    setDemoUser('')
    sessionEndedReason.value = ''
    me.value = null
    building.value = null
    buildingError.value = null
    ++buildingSeq
    selectedApartmentId.value = ''
    sessionRevision.value += 1
    await loadMe()
    appTabSync.broadcast('SESSION_CHANGED')
    resubscribeExistingPushAfterSignIn().catch(() => {})
  }

  async function signOut(): Promise<void> {
    await removeThisBrowserPush().catch(() => {})
    try {
      await logout()
    } catch {
      /* offline: still forget the session locally */
    }
    resetAfterSessionEnd()
    appTabSync.broadcast('LOGOUT')
  }

  function clearSessionEndedReason(): void {
    sessionEndedReason.value = ''
  }

  setSessionEndedHandler((reason) => {
    resetAfterSessionEnd()
    sessionEndedReason.value = reason
    appTabSync.broadcast('LOGOUT')
    import('@/router/index.js')
      .then((mod) => {
        mod.default.push({ name: 'welcome' })
      })
      .catch(() => {})
  })

  if (unsubscribeTabSync) {
    unsubscribeTabSync()
  }
  unsubscribeTabSync = appTabSync.subscribe((evt: TabSyncEvent) => {
    if (evt.type === 'LOGOUT') {
      resetAfterSessionEnd()
      import('@/router/index.js')
        .then((mod) => {
          mod.default.push({ name: 'welcome' })
        })
        .catch(() => {})
    } else if (evt.type === 'SESSION_CHANGED') {
      let storedDemoId = ''
      try {
        storedDemoId =
          typeof localStorage !== 'undefined' ? localStorage.getItem('demo_user_id') || '' : ''
      } catch {
        storedDemoId = ''
      }
      if (!signedIn.value && storedDemoId !== activeDemoUserId.value) {
        switchUser(storedDemoId, { broadcast: false }).catch(() => {})
      } else {
        sessionRevision.value += 1
        loadMe().catch(() => {})
      }
    } else if (evt.type === 'LOCALE_CHANGED' && evt.lang) {
      setLang(evt.lang, { broadcast: false })
    } else if (evt.type === 'THEME_CHANGED' && evt.theme) {
      setTheme(evt.theme, { broadcast: false })
    }
  })

  async function switchUser(
    userId: string,
    { broadcast = true }: { broadcast?: boolean } = {},
  ): Promise<void> {
    if (signedIn.value) return
    invalidateMeRequest()
    if (!userId) {
      me.value = null
      building.value = null
      buildingError.value = null
      buildingLoading.value = false
      ++buildingSeq
      selectedApartmentId.value = ''
      setDemoUser('')
      sessionRevision.value += 1
      if (broadcast) {
        appTabSync.broadcast('SESSION_CHANGED')
      }
      return
    }
    me.value = null
    building.value = null
    buildingError.value = null
    ++buildingSeq
    selectedApartmentId.value = ''
    setDemoUser(userId)
    sessionRevision.value += 1
    if (broadcast) {
      appTabSync.broadcast('SESSION_CHANGED')
    }
    await loadMe()
  }

  async function changePrivacyMode(
    membershipId: string,
    privacyDisplayMode: DisplayMode,
  ): Promise<PrivacyUpdateResponse> {
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

  async function changeNotificationLocale(newLocale: Locale | null): Promise<LocaleUpdate> {
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
   */
  async function signInAsDemoRole(preferredRole: BuildingRole | '' = ''): Promise<boolean> {
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
    knownBuildingApartmentsCount,
    buildingEntrancesCount,
    buildingHeatedArea,
    buildingRegistryFacts,
    meLoading,
    meError,
    buildingLoading,
    buildingError,
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
    refreshBuilding: loadBuilding,
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
