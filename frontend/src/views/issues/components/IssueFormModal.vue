<script setup>
import { ref, computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { localizeError } from '@/locales/index.js'
import {
  getIssueForm,
  listIssues,
  createIssue,
  editIssue,
  followIssue,
} from '@/api/endpoints/issues.js'
import {
  ISSUE_CATEGORIES,
  findMatchingOpenIssues,
  validateIssueReportDraft,
} from '@/utils/issues.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  mode: {
    type: String,
    default: 'create', // 'create' | 'edit'
  },
  issue: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['close', 'saved', 'followed'])

const session = useSessionStore()
const { isChairman, isBoard } = useRole()
const isBoardUser = computed(() => isChairman.value || isBoard.value)

const isLoadingMeta = ref(false)
const isSubmitting = ref(false)
const followingIssueId = ref('')
const formMeta = ref({
  urgent_enabled: false,
  apartment_ids: [],
  entrances: [1, 2],
})
const openIssuesForCheck = ref([])

const draft = ref({
  category: 'LIGHTING',
  entrance: '',
  place: '',
  title: '',
  description: '',
  urgent: false,
  apartment_id: '',
})

const fieldErrors = ref({})
const apiError = ref('')
const rateLimitSeconds = ref(0)

const apartmentLabelById = computed(() => {
  const map = {}
  for (const m of session.memberships || []) {
    map[m.apartment_id] = m.apartment_number
  }
  return map
})

const matchingOpenIssues = computed(() => {
  if (props.mode !== 'create') return []
  return findMatchingOpenIssues(
    openIssuesForCheck.value,
    draft.value.category,
    draft.value.entrance,
  )
})

const rateLimitTimeText = computed(() => {
  if (!rateLimitSeconds.value || rateLimitSeconds.value <= 0) return ''
  const hours = Math.floor(rateLimitSeconds.value / 3600)
  const minutes = Math.max(1, Math.ceil((rateLimitSeconds.value % 3600) / 60))
  if (hours > 0) {
    return session.t('issues.form.rateLimitRetryHoursMinutes', { hours, minutes })
  }
  return session.t('issues.form.rateLimitRetryMinutes', { minutes })
})

async function initializeForm() {
  fieldErrors.value = {}
  apiError.value = ''
  rateLimitSeconds.value = 0

  if (props.mode === 'edit' && props.issue) {
    draft.value = {
      category: props.issue.category || 'LIGHTING',
      entrance:
        props.issue.entrance === null || props.issue.entrance === undefined
          ? ''
          : String(props.issue.entrance),
      place: props.issue.place || '',
      title: props.issue.title || '',
      description: props.issue.description || '',
      urgent: Boolean(props.issue.urgent),
      apartment_id: '',
    }
  } else {
    const defaultEntrance = session.activeMembership?.entrance
      ? String(session.activeMembership.entrance)
      : ''
    draft.value = {
      category: 'LIGHTING',
      entrance: defaultEntrance,
      place: '',
      title: '',
      description: '',
      urgent: false,
      apartment_id: session.activeMembership?.apartment_id || '',
    }
  }

  isLoadingMeta.value = true
  try {
    const [meta, openList] = await Promise.all([
      getIssueForm(),
      props.mode === 'create' ? listIssues({ status: 'OPEN', limit: 100 }) : Promise.resolve([]),
    ])
    formMeta.value = {
      urgent_enabled: Boolean(meta?.urgent_enabled),
      apartment_ids: Array.isArray(meta?.apartment_ids) ? meta.apartment_ids : [],
      entrances:
        Array.isArray(meta?.entrances) && meta.entrances.length > 0 ? meta.entrances : [1, 2],
    }
    openIssuesForCheck.value = Array.isArray(openList) ? openList : []

    if (
      props.mode === 'create' &&
      formMeta.value.apartment_ids.length > 0 &&
      !formMeta.value.apartment_ids.includes(draft.value.apartment_id)
    ) {
      draft.value.apartment_id = formMeta.value.apartment_ids[0]
    }
  } catch (err) {
    apiError.value = localizeError(err, session.lang)
  } finally {
    isLoadingMeta.value = false
  }
}

watch(
  () => [props.open, props.mode, props.issue?.id],
  ([isOpen]) => {
    if (isOpen) {
      initializeForm()
    }
  },
  { immediate: true },
)

async function handleFollowExisting(existingIssue) {
  if (!existingIssue?.id || followingIssueId.value) return
  followingIssueId.value = existingIssue.id
  apiError.value = ''
  try {
    const updated = await followIssue(existingIssue.id)
    emit('followed', updated)
  } catch (err) {
    apiError.value = localizeError(err, session.lang)
  } finally {
    followingIssueId.value = ''
  }
}

async function handleSubmit() {
  fieldErrors.value = {}
  apiError.value = ''
  rateLimitSeconds.value = 0

  if (props.mode === 'edit' && props.issue) {
    const title = String(draft.value.title || '').trim()
    const place = String(draft.value.place || '').trim()
    const description = String(draft.value.description || '').trim()

    if (!title) {
      fieldErrors.value = { title: 'TITLE_REQUIRED' }
      return
    }
    if (title.length > 140) {
      fieldErrors.value = { title: 'TITLE_TOO_LONG' }
      return
    }
    if (place.length > 80) {
      fieldErrors.value = { place: 'PLACE_TOO_LONG' }
      return
    }
    if (description.length > 2000) {
      fieldErrors.value = { description: 'DESCRIPTION_TOO_LONG' }
      return
    }

    isSubmitting.value = true
    try {
      const entranceVal =
        draft.value.entrance === '' ||
        draft.value.entrance === null ||
        Number(draft.value.entrance) === 0
          ? null
          : Number(draft.value.entrance)

      const updated = await editIssue(props.issue.id, {
        category: draft.value.category,
        entrance: entranceVal,
        place: place || null,
        title,
        description,
      })
      emit('saved', updated)
    } catch (err) {
      apiError.value = localizeError(err, session.lang)
    } finally {
      isSubmitting.value = false
    }
    return
  }

  const validation = validateIssueReportDraft(
    draft.value,
    formMeta.value,
    isBoardUser.value,
  )
  if (!validation.valid) {
    fieldErrors.value = validation.errors
    return
  }

  isSubmitting.value = true
  try {
    const created = await createIssue(validation.payload)
    emit('saved', created)
  } catch (err) {
    if (err?.errorCode === 'RATE_LIMITED') {
      rateLimitSeconds.value = Number(err?.payload?.retry_after_seconds || 3600)
      apiError.value = session.t('issues.form.rateLimitReached')
    } else {
      apiError.value = localizeError(err, session.lang)
    }
  } finally {
    isSubmitting.value = false
  }
}

function formatLocationLabel(entrance, place) {
  const base =
    entrance === null || entrance === undefined
      ? session.t('issues.locationOutside')
      : session.t('issues.locationEntrance', { n: entrance })
  return place ? `${base} · ${place}` : base
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-label="
        mode === 'edit' ? session.t('issues.form.editTitle') : session.t('issues.form.reportTitle')
      "
      @click.self="emit('close')"
    >
      <div
        class="w-full max-w-2xl rounded-2xl border border-surface-container bg-surface-container-lowest shadow-xl overflow-hidden my-8"
      >
        <!-- Modal Header -->
        <div
          class="flex items-center justify-between gap-4 border-b border-surface-container px-5 py-4"
        >
          <h2 class="text-lg font-bold text-on-surface">
            {{
              mode === 'edit'
                ? session.t('issues.form.editTitle')
                : session.t('issues.form.reportTitle')
            }}
          </h2>
          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface cursor-pointer transition-colors"
            :aria-label="session.t('common.close')"
            @click="emit('close')"
          >
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <!-- Modal Form Body -->
        <form class="p-5 space-y-5 max-h-[80vh] overflow-y-auto" @submit.prevent="handleSubmit">
          <!-- Common-areas scope notice with link to /messages (#004) -->
          <div
            data-testid="issues-common-area-notice"
            class="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary-container/15 p-3.5 text-sm text-on-surface"
          >
            <span
              class="material-symbols-outlined text-[20px] text-primary shrink-0 mt-0.5"
            >
              info
            </span>
            <div>
              <p class="font-medium">
                {{ session.t('issues.form.commonAreasNotice') }}
              </p>
              <RouterLink
                to="/messages"
                class="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary underline hover:no-underline"
                @click="emit('close')"
              >
                {{ session.t('issues.form.writeToBoardLink') }}
                <span class="material-symbols-outlined text-[15px]">arrow_forward</span>
              </RouterLink>
            </div>
          </div>

          <!-- 429 Rate limit or API error banner -->
          <div
            v-if="apiError"
            data-testid="issue-form-error"
            class="rounded-xl border border-error/30 bg-error-container/30 p-3.5 text-sm text-on-error-container"
          >
            <div class="flex items-start gap-2.5">
              <span
                class="material-symbols-outlined text-[20px] text-error shrink-0"
              >
                error
              </span>
              <div>
                <p class="font-semibold">{{ apiError }}</p>
                <p
                  v-if="rateLimitTimeText"
                  class="mt-1 text-xs text-on-error-container/80"
                >
                  {{ rateLimitTimeText }}
                </p>
              </div>
            </div>
          </div>

          <!-- Apartment selector when user has multiple apartments -->
          <div
            v-if="mode === 'create' && formMeta.apartment_ids.length > 1"
            class="space-y-1.5"
          >
            <label
              for="issue-apartment-select"
              class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
            >
              {{ session.t('issues.form.apartmentLabel') }}
            </label>
            <select
              id="issue-apartment-select"
              v-model="draft.apartment_id"
              data-testid="issue-apartment-select"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option
                v-for="aptId in formMeta.apartment_ids"
                :key="aptId"
                :value="aptId"
              >
                {{
                  apartmentLabelById[aptId]
                    ? session.t('issues.form.apartmentOption', {
                        number: apartmentLabelById[aptId],
                      })
                    : aptId
                }}
              </option>
            </select>
            <p
              v-if="fieldErrors.apartment_id"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.apartment_id}`) }}
            </p>
          </div>

          <!-- Category & Entrance row -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label
                for="issue-category-select"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.categoryLabel') }}
              </label>
              <select
                id="issue-category-select"
                v-model="draft.category"
                data-testid="issue-category-select"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option
                  v-for="cat in ISSUE_CATEGORIES"
                  :key="cat"
                  :value="cat"
                >
                  {{ session.t(`issues.categories.${cat}`) }}
                </option>
              </select>
            </div>

            <div class="space-y-1.5">
              <label
                for="issue-entrance-select"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.locationLabel') }}
              </label>
              <select
                id="issue-entrance-select"
                v-model="draft.entrance"
                data-testid="issue-entrance-select"
                class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">
                  {{ session.t('issues.locationOutside') }}
                </option>
                <option
                  v-for="ent in formMeta.entrances"
                  :key="ent"
                  :value="String(ent)"
                >
                  {{ session.t('issues.locationEntrance', { n: ent }) }}
                </option>
              </select>
            </div>
          </div>

          <!-- Pre-submit matching open issues suggestion (+1 instead of filing duplicate) -->
          <div
            v-if="mode === 'create' && matchingOpenIssues.length > 0"
            data-testid="issue-duplicate-suggestions"
            class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3"
          >
            <div class="flex items-start gap-2.5">
              <span
                class="material-symbols-outlined text-[20px] text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
              >
                lightbulb
              </span>
              <div>
                <h4
                  class="text-xs font-bold uppercase tracking-wider text-amber-900 dark:text-amber-200"
                >
                  {{ session.t('issues.form.matchingIssuesTitle') }}
                </h4>
                <p class="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                  {{ session.t('issues.form.matchingIssuesHint') }}
                </p>
              </div>
            </div>

            <ul class="space-y-2">
              <li
                v-for="existing in matchingOpenIssues"
                :key="existing.id"
                class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg border border-amber-500/25 bg-surface-container-lowest p-3"
              >
                <div class="min-w-0">
                  <RouterLink
                    :to="{ name: 'issue-detail', params: { issueId: existing.id } }"
                    class="text-sm font-semibold text-on-surface hover:text-primary transition-colors"
                    @click="emit('close')"
                  >
                    {{ existing.title }}
                  </RouterLink>
                  <div
                    class="mt-1 flex flex-wrap items-center gap-2 text-xs text-on-surface-variant"
                  >
                    <span>{{ formatLocationLabel(existing.entrance, existing.place) }}</span>
                    <span>·</span>
                    <span class="font-medium text-primary">
                      {{ session.t(`issues.statuses.${existing.status}`) }}
                    </span>
                    <span>·</span>
                    <span>{{ session.t('issues.followersCount', { count: existing.followers }) }}</span>
                  </div>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  <button
                    v-if="existing.can_follow"
                    type="button"
                    :data-testid="`follow-suggestion-${existing.id}`"
                    :disabled="followingIssueId === existing.id"
                    class="inline-flex items-center gap-1 rounded-lg border border-surface-container-high bg-surface-container-low px-3 py-1.5 text-xs font-semibold text-on-surface hover:bg-surface-container cursor-pointer disabled:opacity-60 transition-colors"
                    @click="handleFollowExisting(existing)"
                  >
                    <span class="material-symbols-outlined text-[15px]">thumb_up</span>
                    <span>{{ session.t('issues.followAction') }}</span>
                  </button>
                  <span
                    v-else-if="existing.i_follow"
                    class="inline-flex items-center gap-1 rounded-md bg-primary-container/20 px-2.5 py-1 text-xs font-semibold text-primary"
                  >
                    <span class="material-symbols-outlined text-[15px]">check_circle</span>
                    {{ session.t('issues.youFollowBadge') }}
                  </span>
                </div>
              </li>
            </ul>
          </div>

          <!-- Place within location (optional) -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label
                for="issue-place-input"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.placeLabel') }}
              </label>
              <span class="text-xs text-on-surface-variant">
                {{ (draft.place || '').length }} / 80
              </span>
            </div>
            <input
              id="issue-place-input"
              v-model="draft.place"
              type="text"
              maxlength="80"
              data-testid="issue-place-input"
              :placeholder="session.t('issues.form.placePlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p
              v-if="fieldErrors.place"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.place}`) }}
            </p>
          </div>

          <!-- Title -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label
                for="issue-title-input"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.titleLabel') }}
              </label>
              <span class="text-xs text-on-surface-variant">
                {{ (draft.title || '').length }} / 140
              </span>
            </div>
            <input
              id="issue-title-input"
              v-model="draft.title"
              type="text"
              maxlength="140"
              data-testid="issue-title-input"
              :placeholder="session.t('issues.form.titlePlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p
              v-if="fieldErrors.title"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.title}`) }}
            </p>
          </div>

          <!-- Description -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label
                for="issue-description-input"
                class="block text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
              >
                {{ session.t('issues.form.descriptionLabel') }}
              </label>
              <span class="text-xs text-on-surface-variant">
                {{ (draft.description || '').length }} / 2000
              </span>
            </div>
            <textarea
              id="issue-description-input"
              v-model="draft.description"
              rows="4"
              maxlength="2000"
              data-testid="issue-description-input"
              :placeholder="session.t('issues.form.descriptionPlaceholder')"
              class="w-full rounded-lg border border-surface-container-high bg-surface-container-low/40 px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p
              v-if="fieldErrors.description"
              class="text-xs font-medium text-error"
            >
              {{ session.t(`issues.form.errors.${fieldErrors.description}`) }}
            </p>
          </div>

          <!-- Urgent switch: shown ONLY when urgent_enabled is true in GET /issues/form -->
          <div
            v-if="mode === 'create' && formMeta.urgent_enabled"
            data-testid="issue-urgent-toggle-section"
            class="flex items-start justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5"
          >
            <div>
              <label
                for="issue-urgent-checkbox"
                class="text-sm font-semibold text-on-surface cursor-pointer"
              >
                {{ session.t('issues.form.urgentLabel') }}
              </label>
              <p class="mt-0.5 text-xs text-on-surface-variant">
                {{ session.t('issues.form.urgentHint') }}
              </p>
            </div>
            <input
              id="issue-urgent-checkbox"
              v-model="draft.urgent"
              type="checkbox"
              data-testid="issue-urgent-checkbox"
              class="mt-1 h-4 w-4 rounded border-surface-container-high accent-amber-600 focus:ring-amber-500"
            />
          </div>

          <!-- Footer Actions -->
          <div
            class="flex items-center justify-end gap-3 pt-3 border-t border-surface-container"
          >
            <button
              type="button"
              class="rounded-xl border border-surface-container-high bg-surface-container-low px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container cursor-pointer transition-colors"
              @click="emit('close')"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="submit"
              data-testid="issue-submit-button"
              :disabled="isSubmitting || isLoadingMeta"
              class="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container cursor-pointer disabled:opacity-60 transition-colors"
            >
              <span>
                {{
                  mode === 'edit'
                    ? session.t('issues.form.saveChanges')
                    : session.t('issues.form.submitReport')
                }}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
