<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { getSettings, updateSettings } from '@/api/endpoints/settings.js'
import { localizeError } from '@/locales/index.js'
import { formatDateTime } from '@/utils/dates.js'
import {
  groupSettingsByPrefix,
  buildInitialDraftState,
  computeSettingsDiff,
  extractSettingFieldErrors,
} from '@/utils/associationSettings.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const session = useSessionStore()
const { isChairman, canViewAssociationSettings } = useRole()

const settings = ref([])
const draftValues = ref({})
const draftResets = ref({})
const loading = ref(false)
const saving = ref(false)
const loadError = ref(null)
const saveErrorBanner = ref('')
const saveSuccessBanner = ref('')
const fieldErrorMap = ref({})

let requestSeq = 0

const groupedSettings = computed(() => groupSettingsByPrefix(settings.value))

const pendingDiff = computed(() =>
  computeSettingsDiff(settings.value, draftValues.value, draftResets.value),
)

const hasPendingChanges = computed(() => Object.keys(pendingDiff.value).length > 0)

function resolveGroupTitle(prefix) {
  const key = `associationSettings.groups.${prefix}`
  const translated = session.t(key)
  return translated === key ? prefix : translated
}

function resolveSettingLabel(settingKey) {
  const key = `associationSettings.items.${settingKey}.label`
  const translated = session.t(key)
  return translated === key ? settingKey : translated
}

function resolveSettingHelp(settingKey) {
  const key = `associationSettings.items.${settingKey}.help`
  const translated = session.t(key)
  return translated === key ? '' : translated
}

function formatDefaultDisplay(setting) {
  if (setting.type === 'BOOLEAN') {
    return setting.default
      ? session.t('associationSettings.booleanOn')
      : session.t('associationSettings.booleanOff')
  }
  return String(setting.default)
}

function isSettingModifiedInDraft(setting) {
  return Object.prototype.hasOwnProperty.call(pendingDiff.value, setting.key)
}

function canResetSetting(setting) {
  if (!isChairman.value) return false
  if (draftResets.value[setting.key]) return false
  return !setting.is_default || isSettingModifiedInDraft(setting)
}

function handleIntegerInput(setting, event) {
  if (!isChairman.value) return
  const raw = event.target.value
  draftResets.value = { ...draftResets.value, [setting.key]: false }
  draftValues.value = { ...draftValues.value, [setting.key]: raw }
  clearFieldError(setting.key)
}

function handleBooleanToggle(setting) {
  if (!isChairman.value) return
  const currentVal = Boolean(draftValues.value[setting.key])
  draftResets.value = { ...draftResets.value, [setting.key]: false }
  draftValues.value = { ...draftValues.value, [setting.key]: !currentVal }
  clearFieldError(setting.key)
}

function markResetToDefault(setting) {
  if (!isChairman.value) return
  clearFieldError(setting.key)
  if (!setting.is_default) {
    draftResets.value = { ...draftResets.value, [setting.key]: true }
    draftValues.value = { ...draftValues.value, [setting.key]: setting.default }
  } else {
    draftResets.value = { ...draftResets.value, [setting.key]: false }
    draftValues.value = { ...draftValues.value, [setting.key]: setting.value }
  }
}

function undoResetToDefault(setting) {
  if (!isChairman.value) return
  clearFieldError(setting.key)
  draftResets.value = { ...draftResets.value, [setting.key]: false }
  draftValues.value = { ...draftValues.value, [setting.key]: setting.value }
}

function clearFieldError(settingKey) {
  if (fieldErrorMap.value[settingKey]) {
    const next = { ...fieldErrorMap.value }
    delete next[settingKey]
    fieldErrorMap.value = next
  }
  saveErrorBanner.value = ''
  saveSuccessBanner.value = ''
}

function resolveFieldErrorMessage(setting) {
  const err = fieldErrorMap.value[setting.key]
  if (!err) return ''
  if (setting.type === 'INTEGER') {
    if (err.type.includes('not_in_range') && setting.minimum !== null && setting.maximum !== null) {
      return session.t('associationSettings.fieldOutOfRange', {
        min: setting.minimum,
        max: setting.maximum,
      })
    }
    return session.t('associationSettings.fieldInvalidInteger')
  }
  if (setting.type === 'BOOLEAN') {
    return session.t('associationSettings.fieldInvalidBoolean')
  }
  return session.t('associationSettings.fieldInvalidGeneric')
}

function applyLoadedSettings(loadedList) {
  settings.value = Array.isArray(loadedList) ? loadedList : []
  const initial = buildInitialDraftState(settings.value)
  draftValues.value = initial.values
  draftResets.value = initial.resets
  fieldErrorMap.value = {}
}

async function fetchSettings() {
  if (!canViewAssociationSettings.value) return
  const seq = ++requestSeq
  loading.value = true
  loadError.value = null
  saveErrorBanner.value = ''
  saveSuccessBanner.value = ''

  try {
    const res = await getSettings()
    if (seq !== requestSeq) return
    applyLoadedSettings(res?.settings || [])
  } catch (err) {
    if (seq !== requestSeq) return
    loadError.value = err
  } finally {
    if (seq === requestSeq) {
      loading.value = false
    }
  }
}

function discardChanges() {
  const initial = buildInitialDraftState(settings.value)
  draftValues.value = initial.values
  draftResets.value = initial.resets
  fieldErrorMap.value = {}
  saveErrorBanner.value = ''
  saveSuccessBanner.value = ''
}

async function saveChanges() {
  if (!isChairman.value || saving.value) return
  const diff = pendingDiff.value
  if (Object.keys(diff).length === 0) return

  saving.value = true
  saveErrorBanner.value = ''
  saveSuccessBanner.value = ''
  fieldErrorMap.value = {}

  try {
    const res = await updateSettings({ values: diff })
    applyLoadedSettings(res?.settings || [])
    saveSuccessBanner.value = session.t('associationSettings.savedBanner')
  } catch (err) {
    if (err?.status === 422 || err?.errorCode === 'VALIDATION_ERROR') {
      fieldErrorMap.value = extractSettingFieldErrors(err)
      saveErrorBanner.value = session.t('associationSettings.validationBanner')
    } else {
      saveErrorBanner.value = localizeError(err, {}, session.locale)
    }
  } finally {
    saving.value = false
  }
}

watch(
  () => session.activeUserId,
  () => {
    fetchSettings()
  },
)

onMounted(() => {
  fetchSettings()
})
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <header class="space-y-1.5">
      <p class="text-xs font-medium text-on-surface-variant tracking-wide">
        {{ session.t('associationSettings.kicker') }}
      </p>
      <h1 class="font-title-lg text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
        {{ session.t('associationSettings.title') }}
      </h1>
      <p class="font-body-md text-sm text-on-surface-variant max-w-2xl">
        {{ session.t('associationSettings.subtitle') }}
      </p>
    </header>

    <!-- Board Read-Only Banner -->
    <div
      v-if="!isChairman"
      data-testid="association-settings-readonly-banner"
      class="bg-surface-container-low border border-surface-container rounded-xl px-4 py-3 flex items-start gap-3 text-sm text-on-surface-variant"
      role="status"
    >
      <span class="material-symbols-outlined text-[20px] text-primary shrink-0 mt-0.5">
        visibility
      </span>
      <p>{{ session.t('associationSettings.readOnlyNotice') }}</p>
    </div>

    <!-- Validation / Save Error Banner -->
    <div
      v-if="saveErrorBanner"
      data-testid="association-settings-error-banner"
      class="bg-error-container/80 border border-error/30 text-on-error-container rounded-xl px-4 py-3 flex items-start gap-3 text-sm"
      role="alert"
    >
      <span class="material-symbols-outlined text-[20px] shrink-0 mt-0.5">error</span>
      <p class="font-medium">{{ saveErrorBanner }}</p>
    </div>

    <!-- Save Success Banner -->
    <div
      v-if="saveSuccessBanner"
      data-testid="association-settings-success-banner"
      class="bg-secondary-fixed/60 border border-secondary/30 text-on-secondary-fixed rounded-xl px-4 py-3 flex items-center gap-3 text-sm"
      role="status"
    >
      <span class="material-symbols-outlined text-[20px] shrink-0">check_circle</span>
      <p class="font-medium">{{ saveSuccessBanner }}</p>
    </div>

    <!-- Loading State -->
    <div
      v-if="loading"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 space-y-4"
    >
      <div class="h-5 w-40 bg-surface-container animate-pulse rounded" />
      <div
        v-for="i in 3"
        :key="i"
        class="py-4 border-t border-surface-container flex items-center justify-between gap-4"
      >
        <div class="space-y-2 flex-1">
          <div class="h-4 w-64 bg-surface-container animate-pulse rounded" />
          <div class="h-3 w-96 max-w-full bg-surface-container animate-pulse rounded" />
        </div>
        <div class="h-9 w-24 bg-surface-container animate-pulse rounded-lg" />
      </div>
    </div>

    <!-- Load Error State -->
    <ErrorCard
      v-else-if="loadError"
      :message="localizeError(loadError, {}, session.locale)"
      :trace-id="loadError?.traceId || ''"
      @retry="fetchSettings"
    />

    <!-- Empty State -->
    <div
      v-else-if="groupedSettings.length === 0"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-8 text-center text-sm text-on-surface-variant"
    >
      {{ session.t('associationSettings.empty') }}
    </div>

    <!-- Settings Form Grouped by Prefix -->
    <form v-else class="space-y-6" novalidate @submit.prevent="saveChanges">
      <section
        v-for="group in groupedSettings"
        :key="group.prefix"
        :data-testid="`settings-group-${group.prefix}`"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl divide-y divide-surface-container"
      >
        <!-- Group Header -->
        <div class="px-5 py-4 flex items-center justify-between gap-4">
          <h2 class="font-title-md text-base font-semibold text-on-surface">
            {{ resolveGroupTitle(group.prefix) }}
          </h2>
          <span class="text-xs font-mono text-on-surface-variant">
            {{ group.prefix }}.*
          </span>
        </div>

        <!-- Settings Rows -->
        <div
          v-for="setting in group.settings"
          :key="setting.key"
          :data-testid="`setting-row-${setting.key}`"
          class="px-5 py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4 transition-colors"
          :class="fieldErrorMap[setting.key] ? 'bg-error-container/15' : ''"
        >
          <!-- Label, Help Text, Metadata & Reset Action -->
          <div class="space-y-1.5 flex-1 min-w-0">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <label
                :for="`setting-input-${setting.key}`"
                class="font-medium text-sm text-on-surface"
              >
                {{ resolveSettingLabel(setting.key) }}
              </label>

              <span
                v-if="draftResets[setting.key]"
                :data-testid="`setting-will-reset-${setting.key}`"
                class="text-xs text-primary font-medium"
              >
                · {{
                  session.t('associationSettings.willResetBadge', {
                    default: formatDefaultDisplay(setting),
                  })
                }}
              </span>
              <span
                v-else-if="setting.is_default && !isSettingModifiedInDraft(setting)"
                :data-testid="`setting-default-badge-${setting.key}`"
                class="text-xs text-on-surface-variant"
              >
                · {{ session.t('associationSettings.defaultBadge') }}
              </span>
              <span
                v-else-if="setting.updated_at && !isSettingModifiedInDraft(setting)"
                class="text-xs text-on-surface-variant tabular-nums"
              >
                · {{
                  session.t('associationSettings.updatedAtLabel', {
                    date: formatDateTime(setting.updated_at, session.locale),
                  })
                }}
              </span>
            </div>

            <p
              v-if="resolveSettingHelp(setting.key)"
              class="text-xs text-on-surface-variant leading-relaxed"
            >
              {{ resolveSettingHelp(setting.key) }}
            </p>

            <!-- Bounds / Default Hint & Reset Button -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-on-surface-variant tabular-nums">
              <span v-if="setting.type === 'INTEGER' && setting.minimum !== null && setting.maximum !== null">
                {{
                  session.t('associationSettings.boundsHint', {
                    min: setting.minimum,
                    max: setting.maximum,
                    default: setting.default,
                  })
                }}
              </span>
              <span v-else-if="setting.type === 'BOOLEAN'">
                {{
                  session.t('associationSettings.booleanDefaultHint', {
                    default: formatDefaultDisplay(setting),
                  })
                }}
              </span>

              <button
                v-if="canResetSetting(setting)"
                type="button"
                :data-testid="`setting-reset-btn-${setting.key}`"
                class="text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded whitespace-nowrap shrink-0"
                @click="markResetToDefault(setting)"
              >
                {{ session.t('associationSettings.resetToDefaultBtn') }}
              </button>

              <button
                v-else-if="isChairman && draftResets[setting.key]"
                type="button"
                :data-testid="`setting-undo-reset-btn-${setting.key}`"
                class="text-xs font-medium text-on-surface-variant hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-primary rounded whitespace-nowrap shrink-0"
                @click="undoResetToDefault(setting)"
              >
                {{ session.t('associationSettings.undoResetBtn') }}
              </button>
            </div>

            <!-- Per-Field Validation Error Message -->
            <p
              v-if="fieldErrorMap[setting.key]"
              :data-testid="`setting-error-${setting.key}`"
              class="text-xs font-medium text-error pt-1"
              role="alert"
            >
              {{ resolveFieldErrorMessage(setting) }}
            </p>
          </div>

          <!-- Control Column by Setting Type -->
          <div class="sm:w-44 flex sm:justify-end items-center shrink-0">
            <!-- INTEGER Control -->
            <div v-if="setting.type === 'INTEGER'" class="w-full sm:w-28">
              <input
                :id="`setting-input-${setting.key}`"
                :data-testid="`setting-control-${setting.key}`"
                type="number"
                step="1"
                :min="setting.minimum ?? undefined"
                :max="setting.maximum ?? undefined"
                :value="draftValues[setting.key]"
                :disabled="!isChairman || saving"
                :aria-invalid="Boolean(fieldErrorMap[setting.key])"
                class="w-full px-3 py-2 rounded-lg border text-sm font-mono tabular-nums text-right bg-surface-container-lowest text-on-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60 disabled:bg-surface-container-low"
                :class="
                  fieldErrorMap[setting.key]
                    ? 'border-error focus:ring-error'
                    : 'border-outline-variant'
                "
                @input="handleIntegerInput(setting, $event)"
              />
            </div>

            <!-- BOOLEAN Control -->
            <div v-else-if="setting.type === 'BOOLEAN'" class="flex items-center gap-2.5">
              <button
                :id="`setting-input-${setting.key}`"
                :data-testid="`setting-control-${setting.key}`"
                type="button"
                role="switch"
                :aria-checked="Boolean(draftValues[setting.key])"
                :disabled="!isChairman || saving"
                class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-150 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 disabled:cursor-not-allowed"
                :class="
                  Boolean(draftValues[setting.key]) ? 'bg-primary' : 'bg-surface-container-highest'
                "
                @click="handleBooleanToggle(setting)"
              >
                <span
                  aria-hidden="true"
                  class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-xs transition duration-150 ease-in-out"
                  :class="Boolean(draftValues[setting.key]) ? 'translate-x-5' : 'translate-x-0'"
                />
              </button>
              <span class="text-xs font-medium text-on-surface-variant min-w-[56px]">
                {{
                  Boolean(draftValues[setting.key])
                    ? session.t('associationSettings.booleanOn')
                    : session.t('associationSettings.booleanOff')
                }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- Chairman Action Bar (Sticky when unsaved changes exist) -->
      <div
        v-if="isChairman"
        class="transition-all"
        :class="
          hasPendingChanges
            ? 'sticky bottom-4 z-20 bg-surface-container-lowest/95 backdrop-blur-md border border-primary/30 shadow-lg rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3'
            : 'flex flex-wrap items-center justify-end gap-3 pt-2'
        "
      >
        <div
          v-if="hasPendingChanges"
          class="flex items-center gap-2 text-xs font-semibold text-primary"
        >
          <span class="material-symbols-outlined text-[18px]">edit_note</span>
          <span>
            {{ Object.keys(pendingDiff).length }}
            {{ session.t('associationSettings.title').toLowerCase() }}
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-3 ml-auto">
          <button
            v-if="hasPendingChanges"
            type="button"
            data-testid="association-settings-discard-btn"
            :disabled="saving"
            class="px-4 py-2 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            @click="discardChanges"
          >
            {{ session.t('associationSettings.discardChangesBtn') }}
          </button>

          <button
            type="submit"
            data-testid="association-settings-save-btn"
            :disabled="!hasPendingChanges || saving"
            class="px-5 py-2.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            <span class="material-symbols-outlined text-[16px]">save</span>
            <span>
              {{
                saving
                  ? session.t('associationSettings.savingBtn')
                  : session.t('associationSettings.saveBtn')
              }}
            </span>
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
