<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { getPollResults } from '@/api/endpoints/governance.js'
import { formatPollValue } from '@/utils/pollValidation.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const props = defineProps({
  pollId: {
    type: String,
    required: true,
  },
  poll: {
    type: Object,
    default: null,
  },
})

const session = useSessionStore()

const results = ref(null)
const loading = ref(false)
const loadError = ref(null)
const notFound = ref(false)
const unavailableStatus = ref(null) // 'OPEN' | 'DRAFT' | 'CANCELLED' | null

const participationPercent = computed(() => {
  const part = results.value?.participation
  if (!part || !part.electorate || part.electorate <= 0) return 0
  return Math.min(100, Math.round((part.answered * 100) / part.electorate))
})

const participationText = computed(() => {
  const part = results.value?.participation
  if (!part) return ''
  const unit = results.value?.unit || props.poll?.unit || 'APARTMENT'
  return unit === 'PERSON'
    ? session.t('polls.results.participationPeople', {
        answered: part.answered,
        electorate: part.electorate,
      })
    : session.t('polls.results.participationApartments', {
        answered: part.answered,
        electorate: part.electorate,
      })
})

const enrichedQuestions = computed(() => {
  if (!results.value) return []
  const pollQuestions = props.poll?.questions || []
  const byId = new Map(pollQuestions.map((q) => [q.id, q]))

  return (results.value.questions || []).map((qr, idx) => {
    const qMeta = byId.get(qr.question_id) || pollQuestions[idx] || {}
    const valueType = qMeta.value_type || 'TEXT'
    const answerMode =
      qMeta.answer_mode || (Array.isArray(qr.options) ? 'SINGLE_CHOICE' : 'OWN_VALUE')
    const optionMap = new Map((qMeta.options || []).map((o) => [o.id, o]))

    const optionsWithLabels = Array.isArray(qr.options)
      ? qr.options.map((optRes, oIdx) => {
          const metaOpt = optionMap.get(optRes.option_id) || (qMeta.options || [])[oIdx]
          const rawVal = metaOpt?.value ?? ''
          const pct =
            qr.answered > 0 ? Math.round((optRes.count * 100) / qr.answered) : 0
          return {
            option_id: optRes.option_id,
            count: optRes.count,
            pct,
            barWidth: Math.min(100, pct),
            label: formatPollValue(rawVal, valueType, session.lang) || rawVal,
          }
        })
      : null

    const datesWithLabels = Array.isArray(qr.dates)
      ? qr.dates.map((d) => {
          const pct = qr.answered > 0 ? Math.round((d.count * 100) / qr.answered) : 0
          return {
            value: d.value,
            label: formatPollValue(d.value, 'DATE', session.lang),
            count: d.count,
            pct,
            barWidth: Math.min(100, pct),
          }
        })
      : null

    return {
      question_id: qr.question_id,
      index: idx + 1,
      text: qMeta.text || qMeta.prompt || '',
      answer_mode: answerMode,
      value_type: valueType,
      answered: qr.answered,
      options: optionsWithLabels,
      number: qr.number || null,
      dates: datesWithLabels,
      texts: Array.isArray(qr.texts) ? qr.texts : null,
    }
  })
})

let fetchResultsSeq = 0

async function fetchResults() {
  if (!props.pollId) return
  const seq = ++fetchResultsSeq
  loading.value = true
  loadError.value = null
  notFound.value = false
  unavailableStatus.value = null

  try {
    const data = await getPollResults(props.pollId)
    if (seq !== fetchResultsSeq) return
    results.value = data
  } catch (err) {
    if (seq !== fetchResultsSeq) return
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'POLL_NOT_FOUND') {
      notFound.value = true
      results.value = null
    } else if (err?.status === 409 || code === 'RESULTS_NOT_AVAILABLE') {
      unavailableStatus.value = err?.payload?.status || props.poll?.status || 'OPEN'
      results.value = null
    } else {
      loadError.value = err
    }
  } finally {
    if (seq === fetchResultsSeq) {
      loading.value = false
    }
  }
}

defineExpose({
  refresh: fetchResults,
})

watch(
  () => [
    props.pollId,
    props.poll?.status,
    props.poll?.closes_at,
    props.poll?.my_ballots?.length,
    (props.poll?.my_ballots || []).map((b) => b.updated_at).join(','),
    session.actingUserId,
  ],
  () => {
    fetchResults()
  },
)

onMounted(() => {
  fetchResults()
})
</script>

<template>
  <section
    data-testid="poll-results-section"
    class="space-y-5"
  >
    <!-- 404 Not Found -->
    <div
      v-if="notFound"
      data-testid="poll-results-not-found"
      class="rounded-2xl border border-surface-container bg-surface-container-lowest p-8 text-center"
    >
      <span class="material-symbols-outlined text-3xl text-on-surface-variant">block</span>
      <h2 class="mt-2 text-base font-semibold text-on-surface">
        {{ session.t('polls.notFoundTitle') }}
      </h2>
      <p class="mt-1 text-sm text-on-surface-variant">
        {{ session.t('polls.notFoundBody') }}
      </p>
    </div>

    <!-- 409 RESULTS_NOT_AVAILABLE -->
    <div
      v-else-if="unavailableStatus"
      data-testid="poll-results-unavailable"
      class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-sm text-amber-900 dark:text-amber-200"
    >
      <div class="flex items-start gap-3">
        <span class="material-symbols-outlined text-[22px] text-amber-700 dark:text-amber-400">
          hourglass_top
        </span>
        <div>
          <h2 class="font-semibold">
            {{
              unavailableStatus === 'OPEN'
                ? session.t('polls.results.availableAfterClose')
                : session.t('polls.results.notAvailable')
            }}
          </h2>
        </div>
      </div>
    </div>

    <!-- Error Card -->
    <ErrorCard
      v-else-if="loadError"
      :error="loadError"
      @retry="fetchResults"
    />

    <!-- Loading -->
    <div
      v-else-if="loading && !results"
      class="rounded-2xl border border-surface-container bg-surface-container-lowest p-8 text-center text-sm text-on-surface-variant"
    >
      {{ session.t('polls.results.loading') }}
    </div>

    <!-- Results Content -->
    <template v-else-if="results">
      <!-- Board Live Results Banner (when status === 'OPEN') -->
      <div
        v-if="results.status === 'OPEN'"
        data-testid="poll-results-live-banner"
        class="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary-container/15 px-4 py-3.5 text-sm text-on-surface"
      >
        <span class="material-symbols-outlined text-[20px] text-primary">
          insights
        </span>
        <div>
          <p class="font-semibold">
            {{ session.t('polls.results.liveBadge') }}
          </p>
          <p class="mt-0.5 text-xs text-on-surface-variant">
            {{ session.t('polls.results.liveNotice') }}
          </p>
        </div>
      </div>

      <!-- Participation Card -->
      <div
        data-testid="poll-results-participation"
        class="rounded-2xl border border-surface-container bg-surface-container-lowest p-5"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
              {{ session.t('polls.results.participationHeading') }}
            </p>
            <p class="mt-1 text-base font-bold text-on-surface">
              {{ participationText }}
            </p>
          </div>
          <span class="font-mono text-sm font-semibold text-primary">
            {{ participationPercent }}%
          </span>
        </div>

        <div class="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div
            class="h-full rounded-full bg-primary transition-all duration-300"
            :style="{ width: `${participationPercent}%` }"
          />
        </div>
      </div>

      <!-- Per-Question Results -->
      <div class="space-y-4">
        <div
          v-for="q in enrichedQuestions"
          :key="q.question_id"
          :data-testid="`poll-result-question-${q.question_id}`"
          class="rounded-2xl border border-surface-container bg-surface-container-lowest p-5"
        >
          <div class="flex flex-wrap items-start justify-between gap-2 border-b border-surface-container pb-3">
            <h3 class="text-sm font-semibold text-on-surface">
              {{ q.index }}. {{ q.text }}
            </h3>
            <span class="rounded-md bg-surface-container-low px-2.5 py-0.5 font-mono text-xs font-medium text-on-surface-variant">
              {{ session.t('polls.results.questionAnsweredCount', { count: q.answered }) }}
            </span>
          </div>

          <!-- 1. Choice Questions (SINGLE_CHOICE / MULTIPLE_CHOICE) -->
          <div v-if="q.options" class="mt-4 space-y-3">
            <div
              v-for="opt in q.options"
              :key="opt.option_id"
              :data-testid="`poll-result-option-${opt.option_id}`"
              class="space-y-1.5"
            >
              <div class="flex items-baseline justify-between gap-3 text-sm">
                <span class="font-medium text-on-surface">
                  {{ opt.label }}
                </span>
                <span class="shrink-0 font-mono text-xs font-semibold text-on-surface-variant">
                  {{ opt.count }} ({{ opt.pct }}%)
                </span>
              </div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-surface-container-high">
                <div
                  class="h-full rounded-full bg-primary transition-all duration-300"
                  :style="{ width: `${opt.barWidth}%` }"
                />
              </div>
            </div>
          </div>

          <!-- 2. OWN_VALUE NUMBER -->
          <div
            v-else-if="q.answer_mode === 'OWN_VALUE' && q.value_type === 'NUMBER'"
            class="mt-4"
          >
            <dl
              v-if="q.number"
              data-testid="poll-result-number-stats"
              class="grid grid-cols-1 gap-3 sm:grid-cols-3"
            >
              <div class="rounded-xl border border-surface-container bg-surface-container-low p-3.5">
                <dt class="text-xs font-medium text-on-surface-variant">
                  {{ session.t('polls.results.numberMin') }}
                </dt>
                <dd class="mt-1 font-mono text-base font-bold text-on-surface">
                  {{ formatPollValue(q.number.min, 'NUMBER', session.lang) }}
                </dd>
              </div>

              <div class="rounded-xl border border-surface-container bg-surface-container-low p-3.5">
                <dt class="text-xs font-medium text-on-surface-variant">
                  {{ session.t('polls.results.numberAverage') }}
                </dt>
                <dd class="mt-1 font-mono text-base font-bold text-primary">
                  {{ formatPollValue(q.number.average, 'NUMBER', session.lang) }}
                </dd>
              </div>

              <div class="rounded-xl border border-surface-container bg-surface-container-low p-3.5">
                <dt class="text-xs font-medium text-on-surface-variant">
                  {{ session.t('polls.results.numberMax') }}
                </dt>
                <dd class="mt-1 font-mono text-base font-bold text-on-surface">
                  {{ formatPollValue(q.number.max, 'NUMBER', session.lang) }}
                </dd>
              </div>
            </dl>

            <p v-else class="text-sm italic text-on-surface-variant">
              {{ session.t('polls.results.noAnswersYet') }}
            </p>
          </div>

          <!-- 3. OWN_VALUE DATE -->
          <div
            v-else-if="q.answer_mode === 'OWN_VALUE' && q.value_type === 'DATE'"
            class="mt-4"
          >
            <div
              v-if="q.dates && q.dates.length > 0"
              data-testid="poll-result-dates-list"
              class="space-y-3"
            >
              <div
                v-for="item in q.dates"
                :key="item.value"
                class="space-y-1.5"
              >
                <div class="flex items-baseline justify-between gap-3 text-sm">
                  <span class="font-mono font-medium text-on-surface">
                    {{ item.label }}
                  </span>
                  <span class="shrink-0 font-mono text-xs font-semibold text-on-surface-variant">
                    {{ item.count }} ({{ item.pct }}%)
                  </span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full bg-surface-container-high">
                  <div
                    class="h-full rounded-full bg-primary transition-all duration-300"
                    :style="{ width: `${item.barWidth}%` }"
                  />
                </div>
              </div>
            </div>

            <p v-else class="text-sm italic text-on-surface-variant">
              {{ session.t('polls.results.noAnswersYet') }}
            </p>
          </div>

          <!-- 4. OWN_VALUE TEXT -->
          <div
            v-else
            class="mt-4"
          >
            <template v-if="q.texts !== null">
              <ul
                v-if="q.texts.length > 0"
                data-testid="poll-result-texts-list"
                class="space-y-2"
              >
                <li
                  v-for="(item, tIdx) in q.texts"
                  :key="tIdx"
                  class="flex items-start justify-between gap-3 rounded-xl border border-surface-container bg-surface-container-low/70 px-3.5 py-2.5 text-sm"
                >
                  <span class="whitespace-pre-line text-on-surface">
                    {{ item.value }}
                  </span>
                  <span class="shrink-0 rounded-md bg-surface-container-high px-2 py-0.5 font-mono text-xs font-semibold text-on-surface-variant">
                    ×{{ item.count }}
                  </span>
                </li>
              </ul>
              <p v-else class="text-sm italic text-on-surface-variant">
                {{ session.t('polls.results.noAnswersYet') }}
              </p>
            </template>

            <p
              v-else
              data-testid="poll-result-texts-hidden-note"
              class="text-xs text-on-surface-variant"
            >
              {{ session.t('polls.results.textBoardOnlyNote') }}
            </p>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
