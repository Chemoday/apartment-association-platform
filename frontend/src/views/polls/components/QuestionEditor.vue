<script setup>
import { useSessionStore } from '@/stores/session.js'

const props = defineProps({
  index: {
    type: Number,
    required: true,
  },
  question: {
    type: Object,
    required: true,
  },
  errors: {
    type: Object,
    default: () => ({}),
  },
  canRemove: {
    type: Boolean,
    default: true,
  },
  canMoveUp: {
    type: Boolean,
    default: false,
  },
  canMoveDown: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update', 'remove', 'move-up', 'move-down'])
const session = useSessionStore()

function patchQuestion(changes) {
  const next = {
    ...props.question,
    ...changes,
  }

  if (changes.answer_mode) {
    if (changes.answer_mode === 'OWN_VALUE') {
      next.options = []
      next.min_choices = null
      next.max_choices = null
    } else {
      next.min_value = ''
      next.max_value = ''
      if (!Array.isArray(next.options) || next.options.length < 2) {
        next.options = ['', '']
      }
      if (changes.answer_mode === 'MULTIPLE_CHOICE') {
        next.min_choices = next.min_choices || 1
        next.max_choices = next.max_choices || next.options.length
      } else {
        next.min_choices = null
        next.max_choices = null
      }
    }
  }

  if (changes.value_type) {
    if (next.answer_mode === 'OWN_VALUE' && changes.value_type === 'TEXT') {
      next.min_value = ''
      next.max_value = ''
    }
  }

  emit('update', next)
}

function updateOption(optIdx, val) {
  const opts = Array.isArray(props.question.options) ? [...props.question.options] : []
  opts[optIdx] = val
  patchQuestion({ options: opts })
}

function addOption() {
  const opts = Array.isArray(props.question.options) ? [...props.question.options] : []
  if (opts.length >= 20) return
  opts.push('')
  const changes = { options: opts }
  if (props.question.answer_mode === 'MULTIPLE_CHOICE' && props.question.max_choices === opts.length - 1) {
    changes.max_choices = opts.length
  }
  patchQuestion(changes)
}

function removeOption(optIdx) {
  const opts = Array.isArray(props.question.options) ? [...props.question.options] : []
  if (opts.length <= 2) return
  opts.splice(optIdx, 1)
  const changes = { options: opts }
  if (props.question.answer_mode === 'MULTIPLE_CHOICE') {
    if (Number(props.question.max_choices) > opts.length) {
      changes.max_choices = opts.length
    }
    if (Number(props.question.min_choices) > opts.length) {
      changes.min_choices = opts.length
    }
  }
  patchQuestion(changes)
}

function resolveQuestionError(code) {
  if (!code) return ''
  return session.t(`polls.editor.validation.${code}`)
}
</script>

<template>
  <div
    :data-testid="`question-editor-${index}`"
    class="rounded-xl border p-5 transition-colors"
    :class="
      Object.keys(errors || {}).length > 0
        ? 'border-rose-300 bg-rose-50/20 dark:border-rose-800 dark:bg-rose-950/10'
        : 'border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-800/40'
    "
  >
    <!-- Question Header Bar -->
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 pb-3 dark:border-slate-700/80">
      <span class="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
        {{ session.t('polls.editor.questionNumber', { n: index + 1, number: index + 1 }) }}
      </span>

      <div class="flex items-center gap-1.5">
        <button
          v-if="canMoveUp"
          type="button"
          class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          :title="session.t('polls.editor.moveUp')"
          @click="emit('move-up')"
        >
          ↑
        </button>
        <button
          v-if="canMoveDown"
          type="button"
          class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          :title="session.t('polls.editor.moveDown')"
          @click="emit('move-down')"
        >
          ↓
        </button>
        <button
          v-if="canRemove"
          type="button"
          :data-testid="`question-remove-${index}`"
          class="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-800/70 dark:bg-slate-900 dark:text-rose-300"
          @click="emit('remove')"
        >
          <span class="material-symbols-outlined text-[14px]">delete</span>
          <span>{{ session.t('common.delete') }}</span>
        </button>
      </div>
    </div>

    <!-- Question Prompt / Text -->
    <div class="mt-4">
      <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
        {{ session.t('polls.editor.questionTextLabel') }}
      </label>
      <input
        type="text"
        maxlength="500"
        :data-testid="`question-text-${index}`"
        :value="question.text"
        :placeholder="session.t('polls.editor.questionTextPlaceholder')"
        class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        @input="patchQuestion({ text: $event.target.value })"
      />
      <p
        v-if="errors?.text"
        class="mt-1 text-xs font-semibold text-rose-600 dark:text-rose-400"
      >
        {{ resolveQuestionError(errors.text) }}
      </p>
    </div>

    <!-- Mode, Value Type & Required Row -->
    <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div>
        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
          {{ session.t('polls.editor.answerModeLabel') }}
        </label>
        <select
          :data-testid="`question-mode-${index}`"
          :value="question.answer_mode"
          class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          @change="patchQuestion({ answer_mode: $event.target.value })"
        >
          <option value="SINGLE_CHOICE">
            {{ session.t('polls.editor.answerModes.SINGLE_CHOICE') }}
          </option>
          <option value="MULTIPLE_CHOICE">
            {{ session.t('polls.editor.answerModes.MULTIPLE_CHOICE') }}
          </option>
          <option value="OWN_VALUE">
            {{ session.t('polls.editor.answerModes.OWN_VALUE') }}
          </option>
        </select>
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
          {{ session.t('polls.editor.valueTypeLabel') }}
        </label>
        <select
          :data-testid="`question-value-type-${index}`"
          :value="question.value_type"
          class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          @change="patchQuestion({ value_type: $event.target.value })"
        >
          <option value="TEXT">
            {{ session.t('polls.editor.valueTypes.TEXT') }}
          </option>
          <option value="NUMBER">
            {{ session.t('polls.editor.valueTypes.NUMBER') }}
          </option>
          <option value="DATE">
            {{ session.t('polls.editor.valueTypes.DATE') }}
          </option>
        </select>
      </div>

      <div class="flex items-end pb-1.5">
        <label class="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-800 dark:text-slate-200">
          <input
            type="checkbox"
            :data-testid="`question-required-${index}`"
            :checked="question.required !== false"
            class="h-4 w-4 rounded text-teal-600 focus:ring-teal-500"
            @change="patchQuestion({ required: $event.target.checked })"
          />
          <span>{{ session.t('polls.editor.requiredSwitch') }}</span>
        </label>
      </div>
    </div>

    <!-- Choice Options (SINGLE_CHOICE / MULTIPLE_CHOICE) -->
    <div
      v-if="question.answer_mode === 'SINGLE_CHOICE' || question.answer_mode === 'MULTIPLE_CHOICE'"
      class="mt-4 space-y-3 border-t border-slate-200/70 pt-4 dark:border-slate-700/70"
    >
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold text-slate-700 dark:text-slate-300">
          {{ session.t('polls.editor.optionsLabel') }}
        </span>
        <button
          v-if="(question.options || []).length < 20"
          type="button"
          :data-testid="`question-add-option-${index}`"
          class="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          @click="addOption"
        >
          <span class="material-symbols-outlined text-[14px]">add</span>
          <span>{{ session.t('polls.editor.addOptionBtn') }}</span>
        </button>
      </div>

      <div class="space-y-2">
        <div
          v-for="(optVal, optIdx) in question.options"
          :key="optIdx"
          class="flex items-center gap-2"
        >
          <span class="w-6 text-right font-mono text-xs text-slate-400">
            {{ optIdx + 1 }}.
          </span>

          <!-- DATE Option Picker -->
          <input
            v-if="question.value_type === 'DATE'"
            type="date"
            :data-testid="`question-${index}-option-${optIdx}`"
            :value="optVal"
            class="block flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            @input="updateOption(optIdx, $event.target.value)"
          />

          <!-- NUMBER Option Input -->
          <input
            v-else-if="question.value_type === 'NUMBER'"
            type="text"
            inputmode="decimal"
            :data-testid="`question-${index}-option-${optIdx}`"
            :value="optVal"
            :placeholder="session.t('polls.numberPlaceholder')"
            class="block flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            @input="updateOption(optIdx, $event.target.value)"
          />

          <!-- TEXT Option Input -->
          <input
            v-else
            type="text"
            maxlength="200"
            :data-testid="`question-${index}-option-${optIdx}`"
            :value="optVal"
            :placeholder="session.t('polls.editor.optionPlaceholder', { n: optIdx + 1, number: optIdx + 1 })"
            class="block flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            @input="updateOption(optIdx, $event.target.value)"
          />

          <button
            v-if="(question.options || []).length > 2"
            type="button"
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-rose-600 dark:hover:bg-slate-800"
            :title="session.t('common.delete')"
            @click="removeOption(optIdx)"
          >
            <span class="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      </div>

      <p
        v-if="errors?.options"
        class="text-xs font-semibold text-rose-600 dark:text-rose-400"
      >
        {{ resolveQuestionError(errors.options) }}
      </p>

      <!-- MULTIPLE_CHOICE min_choices / max_choices -->
      <div
        v-if="question.answer_mode === 'MULTIPLE_CHOICE'"
        class="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2"
      >
        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            {{ session.t('polls.editor.minChoicesLabel') }}
          </label>
          <input
            type="number"
            min="1"
            :max="(question.options || []).length || 20"
            :value="question.min_choices ?? 1"
            class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            @input="patchQuestion({ min_choices: Number($event.target.value) })"
          />
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            {{ session.t('polls.editor.maxChoicesLabel') }}
          </label>
          <input
            type="number"
            min="1"
            :max="(question.options || []).length || 20"
            :value="question.max_choices ?? ((question.options || []).length || 2)"
            class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            @input="patchQuestion({ max_choices: Number($event.target.value) })"
          />
        </div>

        <p
          v-if="errors?.choices"
          class="col-span-full text-xs font-semibold text-rose-600 dark:text-rose-400"
        >
          {{ resolveQuestionError(errors.choices) }}
        </p>
      </div>
    </div>

    <!-- OWN_VALUE Bounds for NUMBER or DATE -->
    <div
      v-else-if="
        question.answer_mode === 'OWN_VALUE' &&
        (question.value_type === 'NUMBER' || question.value_type === 'DATE')
      "
      class="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200/70 pt-4 sm:grid-cols-2 dark:border-slate-700/70"
    >
      <div>
        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
          {{ session.t('polls.editor.minValueLabel') }}
        </label>
        <input
          v-if="question.value_type === 'DATE'"
          type="date"
          :value="question.min_value || ''"
          class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          @input="patchQuestion({ min_value: $event.target.value })"
        />
        <input
          v-else
          type="text"
          inputmode="decimal"
          :value="question.min_value || ''"
          :placeholder="session.t('polls.editor.optionalBoundPlaceholder')"
          class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          @input="patchQuestion({ min_value: $event.target.value })"
        />
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
          {{ session.t('polls.editor.maxValueLabel') }}
        </label>
        <input
          v-if="question.value_type === 'DATE'"
          type="date"
          :value="question.max_value || ''"
          class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          @input="patchQuestion({ max_value: $event.target.value })"
        />
        <input
          v-else
          type="text"
          inputmode="decimal"
          :value="question.max_value || ''"
          :placeholder="session.t('polls.editor.optionalBoundPlaceholder')"
          class="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 focus:border-teal-600 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          @input="patchQuestion({ max_value: $event.target.value })"
        />
      </div>

      <p
        v-if="errors?.bounds"
        class="col-span-full text-xs font-semibold text-rose-600 dark:text-rose-400"
      >
        {{ resolveQuestionError(errors.bounds) }}
      </p>
    </div>
  </div>
</template>
