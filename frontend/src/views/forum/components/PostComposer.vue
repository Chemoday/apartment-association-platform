<script setup>
import { ref, computed, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { createPost } from '@/api/endpoints/communication.js'
import { listApartments } from '@/api/endpoints/property.js'
import { localizeError } from '@/locales/index.js'
import {
  getAllowedForumTopicTargets,
  getEligibleAuthorMemberships,
} from '@/utils/communication.js'
import { objectName } from '@/utils/objectName.js'
import BaseModal from '@/components/base/BaseModal.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import BaseInput from '@/components/base/BaseInput.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import TargetScopePicker from '@/components/domain/TargetScopePicker.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close', 'created'])
const session = useSessionStore()
const { canPublishOfficial, buildingRole } = useRole()

const postType = ref('FORUM_TOPIC')
const category = ref('GENERAL')
const title = ref('')
const body = ref('')
const commentsEnabled = ref(true)
const submitting = ref(false)
const errorMsg = ref('')
const targetError = ref('')
const apartments = ref([])
const selectedAuthorApartmentId = ref(null)

const targetModel = ref({
  target_scope: 'ALL_BUILDING',
  target_entrance: null,
  target_apartment_ids: null,
  target_kinds: null,
})

const forumTopicTargets = computed(() =>
  getAllowedForumTopicTargets({
    role: buildingRole.value,
    memberships: session.memberships || [],
    buildingKinds: session.availableObjectKinds || ['APARTMENT'],
  }),
)

const pickerAllowedScopes = computed(() => {
  if (postType.value === 'OFFICIAL_NOTICE' || postType.value === 'EMERGENCY') {
    return ['ALL_BUILDING', 'ALL_OBJECTS', 'KINDS', 'ENTRANCE', 'APARTMENT_LIST']
  }
  return forumTopicTargets.value.allowedScopes
})

const pickerAvailableKinds = computed(() => {
  if (postType.value === 'OFFICIAL_NOTICE' || postType.value === 'EMERGENCY') {
    return session.availableObjectKinds || ['APARTMENT']
  }
  return forumTopicTargets.value.availableKinds
})

const showTargetPicker = computed(() => {
  if (postType.value === 'OFFICIAL_NOTICE' || postType.value === 'EMERGENCY') {
    return canPublishOfficial.value
  }
  return (
    pickerAllowedScopes.value.length > 1 ||
    (pickerAllowedScopes.value.length === 1 && pickerAllowedScopes.value[0] === 'KINDS')
  )
})

function resetTargetToDefault() {
  if (postType.value === 'OFFICIAL_NOTICE' || postType.value === 'EMERGENCY') {
    targetModel.value = {
      target_scope: 'ALL_BUILDING',
      target_entrance: null,
      target_apartment_ids: null,
      target_kinds: null,
    }
    return
  }
  targetModel.value = {
    target_scope: forumTopicTargets.value.defaultScope,
    target_entrance: null,
    target_apartment_ids: null,
    target_kinds: forumTopicTargets.value.defaultKinds ? [...forumTopicTargets.value.defaultKinds] : null,
  }
}

watch(
  () => [props.open, postType.value, pickerAllowedScopes.value, pickerAvailableKinds.value],
  ([isOpen]) => {
    if (!isOpen) return
    const curScope = targetModel.value.target_scope || 'ALL_BUILDING'
    if (!pickerAllowedScopes.value.includes(curScope)) {
      resetTargetToDefault()
    } else if (curScope === 'KINDS') {
      const validKinds = (targetModel.value.target_kinds || []).filter((k) =>
        pickerAvailableKinds.value.includes(k),
      )
      if (validKinds.length === 0 && pickerAvailableKinds.value.length > 0) {
        targetModel.value = {
          ...targetModel.value,
          target_kinds: [pickerAvailableKinds.value[0]],
        }
      }
    }
  },
  { immediate: true },
)

const availableEntrances = computed(() => {
  const set = new Set([1, 2])
  for (const a of apartments.value) {
    if (typeof a.entrance === 'number' && !Number.isNaN(a.entrance)) {
      set.add(a.entrance)
    }
  }
  return Array.from(set).sort((a, b) => a - b)
})

watch(
  () => [props.open, canPublishOfficial.value],
  async ([isOpen, isBoard]) => {
    if (isOpen && isBoard && apartments.value.length === 0) {
      try {
        const res = await listApartments()
        if (Array.isArray(res?.apartments)) {
          apartments.value = res.apartments
        }
      } catch {
        // Keep empty list fallback
      }
    }
  },
  { immediate: true },
)

const availableTypes = computed(() => {
  const list = [
    {
      value: 'FORUM_TOPIC',
      label: session.t('forum.composer.typeForumTopic'),
      icon: 'forum',
    },
  ]
  if (canPublishOfficial.value) {
    list.push({
      value: 'OFFICIAL_NOTICE',
      label: session.t('forum.composer.typeOfficialNotice'),
      icon: 'campaign',
    })
    list.push({
      value: 'EMERGENCY',
      label: session.t('forum.composer.typeEmergency'),
      icon: 'warning',
    })
  }
  return list
})

const categories = computed(() => [
  { value: 'GENERAL', label: session.t('forum.filterGeneral') },
  { value: 'MAINTENANCE', label: session.t('forum.filterMaintenance') },
  { value: 'WATER_SHUTOFF', label: session.t('forum.waterShutoffCategory') },
  { value: 'MARKETPLACE', label: session.t('forum.filterMarketplace') },
])

const eligibleAuthorMemberships = computed(() => {
  if (postType.value === 'OFFICIAL_NOTICE' || postType.value === 'EMERGENCY') {
    return []
  }
  return getEligibleAuthorMemberships(session.memberships || [], targetModel.value)
})

watch(
  eligibleAuthorMemberships,
  (mems) => {
    if (!mems.length) {
      selectedAuthorApartmentId.value = null
      return
    }
    if (mems.some((m) => m.apartment_id === selectedAuthorApartmentId.value)) {
      return
    }
    const activeId = session.activeMembership?.apartment_id
    selectedAuthorApartmentId.value =
      activeId && mems.some((m) => m.apartment_id === activeId)
        ? activeId
        : mems[0].apartment_id
  },
  { immediate: true },
)

const previewBadge = computed(() => {
  const chosen = eligibleAuthorMemberships.value.find(
    (m) => m.apartment_id === selectedAuthorApartmentId.value,
  )
  if (chosen?.preview_badge) {
    return chosen.preview_badge
  }
  return {
    display_label:
      buildingRole.value === 'CHAIRMAN'
        ? session.t('buildingRole.CHAIRMAN')
        : buildingRole.value === 'BOARD'
          ? session.t('buildingRole.BOARD')
          : session.currentDemoUser?.label || 'Board',
    role_badge: buildingRole.value === 'ACCOUNTANT' ? 'ACCOUNTANT' : 'BOARD',
  }
})

async function handleSubmit() {
  errorMsg.value = ''
  targetError.value = ''
  if (!title.value.trim() || !body.value.trim()) {
    errorMsg.value = session.t('forum.composer.validationRequired')
    return
  }

  const scope = targetModel.value.target_scope || 'ALL_BUILDING'
  const payload = {
    post_type: postType.value,
    category: category.value,
    title: title.value.trim(),
    body: body.value.trim(),
    target_scope: scope,
    comments_enabled: commentsEnabled.value,
  }

  if (scope === 'ENTRANCE') {
    const ent = Number(targetModel.value.target_entrance)
    if (!Number.isInteger(ent) || ent < 1) {
      targetError.value = session.t('polls.editor.validation.INVALID_TARGET_ENTRANCE')
      return
    }
    payload.target_entrance = ent
  } else if (scope === 'APARTMENT_LIST') {
    const ids = Array.isArray(targetModel.value.target_apartment_ids)
      ? targetModel.value.target_apartment_ids.filter(Boolean)
      : []
    if (ids.length === 0) {
      targetError.value = session.t('polls.editor.validation.INVALID_TARGET_APARTMENTS')
      return
    }
    payload.target_apartment_ids = ids
  } else if (scope === 'KINDS') {
    const kinds = Array.isArray(targetModel.value.target_kinds)
      ? targetModel.value.target_kinds.filter(Boolean)
      : []
    if (kinds.length === 0) {
      targetError.value = session.t('polls.editor.validation.INVALID_TARGET_KINDS')
      return
    }
    payload.target_kinds = kinds
  }

  if (
    postType.value === 'FORUM_TOPIC' &&
    selectedAuthorApartmentId.value &&
    eligibleAuthorMemberships.value.some((m) => m.apartment_id === selectedAuthorApartmentId.value)
  ) {
    payload.author_apartment_id = selectedAuthorApartmentId.value
  }

  submitting.value = true
  try {
    const created = await createPost(payload)
    title.value = ''
    body.value = ''
    postType.value = 'FORUM_TOPIC'
    category.value = 'GENERAL'
    resetTargetToDefault()
    emit('created', created)
    emit('close')
  } catch (err) {
    const code = err?.errorCode || (err?.status === 403 ? 'FORBIDDEN' : null)
    errorMsg.value = localizeError(code, err?.payload, session.lang)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="session.t('forum.composer.modalTitle')"
    max-width="max-w-xl"
    @close="emit('close')"
  >
    <form class="space-y-4" @submit.prevent="handleSubmit">
      <!-- Author privacy preview (+ eligible object picker when >1 objects match target) -->
      <div class="p-3 rounded-lg bg-surface-container-low border border-surface-container flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-on-surface-variant font-medium">
          {{ session.t('forum.composer.postingAs') }}
        </span>
        <div class="flex items-center gap-2">
          <select
            v-if="eligibleAuthorMemberships.length > 1"
            v-model="selectedAuthorApartmentId"
            data-testid="post-composer-author-object-select"
            class="rounded-lg border border-surface-container-high bg-surface-container-lowest px-2.5 py-1 text-xs font-medium text-on-surface focus:border-primary focus:outline-none"
          >
            <option
              v-for="m in eligibleAuthorMemberships"
              :key="m.apartment_id"
              :value="m.apartment_id"
            >
              {{ objectName(m.apartment_kind, m.apartment_number, session.t) }}
            </option>
          </select>
          <AuthorBadge :badge="previewBadge" />
        </div>
      </div>

      <!-- Post Type Selection (Board can also publish Official Notice / Emergency) -->
      <div v-if="availableTypes.length > 1">
        <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">
          {{ session.t('forum.composer.postTypeLabel') }}
        </label>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            v-for="tItem in availableTypes"
            :key="tItem.value"
            type="button"
            class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors text-left"
            :class="
              postType === tItem.value
                ? 'bg-primary text-on-primary border-primary'
                : 'bg-surface-container-lowest text-on-surface border-outline-variant/40 hover:bg-surface-container-low'
            "
            @click="postType = tItem.value"
          >
            <span class="material-symbols-outlined text-[16px]">{{ tItem.icon }}</span>
            <span class="truncate">{{ tItem.label }}</span>
          </button>
        </div>
      </div>

      <!-- Target Scope Picker for Forum Topics (#067) and Official Notices / Emergencies (#065) -->
      <TargetScopePicker
        v-if="showTargetPicker"
        v-model="targetModel"
        :apartments="apartments"
        :available-entrances="availableEntrances"
        :available-kinds="pickerAvailableKinds"
        :allowed-scopes="pickerAllowedScopes"
        :error-message="targetError"
        test-id-prefix="post-composer"
        @change="targetError = ''"
      />

      <!-- Category selection -->
      <div>
        <label class="block text-xs font-semibold text-on-surface-variant mb-1.5">
          {{ session.t('forum.composer.categoryLabel') }}
        </label>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button
            v-for="cat in categories"
            :key="cat.value"
            type="button"
            class="px-3 py-2 rounded-lg text-xs font-semibold border transition-colors text-center"
            :class="
              category === cat.value
                ? 'bg-primary-container text-on-primary border-primary'
                : 'bg-surface-container-lowest text-on-surface border-outline-variant/40 hover:bg-surface-container-low'
            "
            @click="category = cat.value"
          >
            {{ cat.label }}
          </button>
        </div>
      </div>

      <BaseInput
        id="post-composer-title"
        v-model="title"
        :label="session.t('forum.composer.titleLabel')"
        :placeholder="session.t('forum.composer.titlePlaceholder')"
      />

      <div>
        <label for="post-composer-body" class="block text-xs font-semibold text-on-surface-variant mb-1">
          {{ session.t('forum.composer.bodyLabel') }} *
        </label>
        <textarea
          id="post-composer-body"
          v-model="body"
          rows="5"
          class="w-full rounded-lg bg-surface-container-lowest px-3 py-2 text-sm text-on-surface border border-outline-variant/60 focus:outline-none focus:ring-2 focus:ring-primary"
          :placeholder="session.t('forum.composer.bodyPlaceholder')"
          required
        />
      </div>

      <label class="inline-flex items-center gap-2 text-xs text-on-surface cursor-pointer">
        <input v-model="commentsEnabled" type="checkbox" class="rounded border-outline-variant" />
        <span>{{ session.t('forum.composer.allowCommentsLabel') }}</span>
      </label>

      <p v-if="errorMsg" class="text-xs text-error font-medium">
        {{ errorMsg }}
      </p>
    </form>

    <template #footer>
      <BaseButton variant="secondary" @click="emit('close')">
        {{ session.t('common.cancel') }}
      </BaseButton>
      <BaseButton
        variant="primary"
        :loading="submitting"
        @click="handleSubmit"
      >
        {{ session.t('forum.composer.publishBtn') }}
      </BaseButton>
    </template>
  </BaseModal>
</template>
