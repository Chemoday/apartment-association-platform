import {
  UNHANDLED,
  OFFLINE_APARTMENT_CARDS,
  OFFLINE_MEMBERSHIPS_BY_USER,
  BASE_APARTMENTS_2026_10,
  getOfflinePeriods,
  getPeriodMasterMeters,
  getPeriodApartments,
  findOfflineMeterInPeriod,
  findOfflineMasterMeterInPeriod,
  computeOfflineNextSubmission,
  makeOfflineError,
} from './state.js'
import {
  addDecimal,
  buildPeriodCsv,
  defaultMeterThresholdScaled,
  fromBigInt3,
  subDecimal,
  toBigInt3,
  validatePeriodStatusTransition,
} from '../../utils/metersMockHelpers.js'
import {
  buildApartmentConsumptionResponse,
  buildBuildingConsumptionResponse,
  parseConsumptionMonths,
} from '../../utils/consumption.js'

export async function handleOfflineMeters(ctx) {
  const { urlObj, pathname, method, body, raw, user, headers } = ctx

  // 4. GET /meters/periods
  if (pathname === '/meters/periods' && method === 'GET') {
    return { periods: JSON.parse(JSON.stringify(getOfflinePeriods())) }
  }

  // Helper shared by /readings and /consumption so histories stay 100% consistent
  function buildOfflineApartmentMeters(cardMeta) {
    const baseApt =
      BASE_APARTMENTS_2026_10.find((a) => a.apartment_id === cardMeta.apartment_id) ||
      BASE_APARTMENTS_2026_10[0]
    const meters = baseApt.meters.map((baseMeter, mIdx) => {
      const readings = []
      for (const p of getOfflinePeriods()) {
        const periodApt = getPeriodApartments(p.period_code).find(
          (a) => a.apartment_id === baseApt.apartment_id,
        )
        const periodMeter = periodApt?.meters.find((m) => m.meter_id === baseMeter.meter_id)
        if (periodMeter?.reading) {
          readings.push({
            period_code: p.period_code,
            reading_id: periodMeter.reading.reading_id,
            value: periodMeter.reading.value,
            consumption_delta: periodMeter.reading.consumption_delta,
            source: p.period_code === '2026-08' && mIdx === 0 ? 'AUTO_ESTIMATED' : periodMeter.reading.source,
            is_anomaly_confirmed: Boolean(periodMeter.reading.is_anomaly_confirmed),
            previous_origin: periodMeter.reading.previous_origin || 'HISTORY',
          })
        }
      }
      return {
        meter_id: baseMeter.meter_id,
        resource_type: baseMeter.resource_type,
        serial_number: baseMeter.serial_number ?? null,
        location_label: baseMeter.location_label,
        unit: baseMeter.unit,
        is_active: true,
        readings,
      }
    })
    if (cardMeta.apartment_number === '14') {
      meters.push({
        meter_id: '018f0000-0000-7000-8000-000000000599',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-1429-OLD',
        location_label: 'Kitchen Cold Water (Old)',
        unit: 'm3',
        is_active: false,
        readings: [
          {
            period_code: '2026-07',
            reading_id: '018f0000-0000-7000-8000-000000000999',
            value: '79.900',
            consumption_delta: '2.000',
            source: 'RESIDENT',
            is_anomaly_confirmed: false,
            previous_origin: 'HISTORY',
          },
        ],
      })
    }
    return meters
  }

  function safeDecodePathSegment(raw) {
    try {
      return decodeURIComponent(raw)
    } catch {
      return ''
    }
  }

  // 4b. GET /meters/apartments/:id/readings (E8/P1)
  const offlineAptReadingsMatch = pathname.match(/^\/meters\/apartments\/([^/]+)\/readings$/)
  if (offlineAptReadingsMatch && method === 'GET') {
    const aptId = safeDecodePathSegment(offlineAptReadingsMatch[1])
    const cardMeta = aptId ? OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === aptId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const isStaff = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    const isOwn = Boolean(aptId) && userMems.some((m) => m.apartment_id === aptId)
    if (!cardMeta || (!isStaff && !isOwn)) {
      const err = new Error('Apartment not found')
      err.status = 404
      err.errorCode = 'APARTMENT_NOT_FOUND'
      err.payload = { error_code: 'APARTMENT_NOT_FOUND' }
      throw err
    }
    return {
      apartment_id: cardMeta.apartment_id,
      apartment_number: cardMeta.apartment_number,
      periods: JSON.parse(JSON.stringify(getOfflinePeriods())),
      meters: buildOfflineApartmentMeters(cardMeta),
    }
  }

  // 4c. GET /meters/apartments/:id/consumption (#030)
  const offlineAptConsumptionMatch = pathname.match(/^\/meters\/apartments\/([^/]+)\/consumption$/)
  if (offlineAptConsumptionMatch && method === 'GET') {
    const aptId = safeDecodePathSegment(offlineAptConsumptionMatch[1])
    const cardMeta = aptId ? OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === aptId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const isStaff = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    const isOwn = Boolean(aptId) && userMems.some((m) => m.apartment_id === aptId)
    if (!cardMeta || (!isStaff && !isOwn)) {
      const err = new Error('Apartment not found')
      err.status = 404
      err.errorCode = 'APARTMENT_NOT_FOUND'
      err.payload = { error_code: 'APARTMENT_NOT_FOUND' }
      throw err
    }
    const parsedMonths = parseConsumptionMonths(urlObj.searchParams.get('months'))
    if (!parsedMonths.ok) {
      const err = new Error(parsedMonths.message || 'Invalid months parameter')
      err.status = 422
      err.errorCode = 'VALIDATION_ERROR'
      err.payload = { error_code: 'VALIDATION_ERROR', message: parsedMonths.message }
      throw err
    }
    return buildApartmentConsumptionResponse({
      apartmentId: cardMeta.apartment_id,
      apartmentNumber: cardMeta.apartment_number,
      periods: getOfflinePeriods(),
      meters: buildOfflineApartmentMeters(cardMeta),
      months: parsedMonths.months,
    })
  }

  // 4d. GET /meters/consumption (#031) - staff only (CHAIRMAN, BOARD, ACCOUNTANT)
  if (pathname === '/meters/consumption' && method === 'GET') {
    const isStaff = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    if (!isStaff) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman, Board, or Accountant role required.')
    }
    const parsedMonths = parseConsumptionMonths(urlObj.searchParams.get('months'))
    if (!parsedMonths.ok) {
      const msg = parsedMonths.message || 'Invalid months parameter'
      throw makeOfflineError(422, 'VALIDATION_ERROR', msg, {
        errors: [{ field: 'months', message: msg }],
      })
    }
    const apartmentsPayload = BASE_APARTMENTS_2026_10.map((baseApt) => {
      const cardMeta = OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === baseApt.apartment_id)
      return {
        apartment_id: baseApt.apartment_id,
        area_m2: cardMeta?.area_m2 || '0',
        meters: buildOfflineApartmentMeters(cardMeta || baseApt),
      }
    })
    return buildBuildingConsumptionResponse({
      periods: getOfflinePeriods(),
      apartments: apartmentsPayload,
      months: parsedMonths.months,
    })
  }

  // 5. GET /meters/my-dashboard
  if (pathname === '/meters/my-dashboard' && method === 'GET') {
    const requestedPeriodCode = urlObj.searchParams.get('period_code')
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const userAptIds = new Set(userMems.map((m) => m.apartment_id))
    const memByAptId = new Map(userMems.map((m) => [m.apartment_id, m]))

    let periodCode = requestedPeriodCode
    if (!periodCode) {
      const refApts = getPeriodApartments('2026-10')
      let hasPendingPrev = false
      for (const a of refApts) {
        if (!userAptIds.has(a.apartment_id)) continue
        const memCanSubmit = Boolean(memByAptId.get(a.apartment_id)?.can_submit_readings)
        for (const m of a.meters) {
          const sub = computeOfflineNextSubmission(m.meter_id, a.can_submit_readings, memCanSubmit)
          if (sub?.period_code === '2026-10') {
            hasPendingPrev = true
            break
          }
        }
        if (hasPendingPrev) break
      }
      periodCode = hasPendingPrev ? '2026-10' : '2026-11'
    }

    const activePeriods = getOfflinePeriods()
    const period =
      activePeriods.find((p) => p.period_code === periodCode) || activePeriods[0]
    const periodApts = getPeriodApartments(period.period_code)

    const baseCanSubmitByAptId = new Map(
      BASE_APARTMENTS_2026_10.map((a) => [a.apartment_id, Boolean(a.can_submit_readings)]),
    )

    const apartments = periodApts
      .filter((a) => userAptIds.has(a.apartment_id))
      .map((a) => {
        const memCanSubmit = Boolean(memByAptId.get(a.apartment_id)?.can_submit_readings)
        const baseAptCanSubmit = baseCanSubmitByAptId.get(a.apartment_id) ?? false
        return {
          apartment_id: a.apartment_id,
          apartment_number: a.apartment_number,
          can_submit_readings: baseAptCanSubmit && memCanSubmit,
          meters: a.meters.map((m) => ({
            meter_id: m.meter_id,
            resource_type: m.resource_type,
            serial_number: m.serial_number ?? null,
            location_label: m.location_label,
            unit: m.unit,
            previous_value: m.previous_value,
            needs_start: Boolean(m.needs_start),
            previous_delta: m.historical_avg ?? null,
            average_delta: m.historical_avg ?? null,
            reading: m.reading ? { ...m.reading } : null,
            next_submission: computeOfflineNextSubmission(
              m.meter_id,
              baseAptCanSubmit,
              memCanSubmit,
            ),
          })),
        }
      })

    return {
      period: { ...period },
      apartments,
    }
  }

  // 5b. POST /meters/readings
  if (pathname === '/meters/readings' && method === 'POST') {
    const payload = body || {}
    const {
      meter_id,
      period_code = '2026-10',
      value,
      confirmation_level = 0,
      reason = null,
    } = payload
    const hasPreviousValueKey = Object.prototype.hasOwnProperty.call(payload, 'previous_value')
    const rawPreviousValue = hasPreviousValueKey ? payload.previous_value : undefined

    const periods = getOfflinePeriods()
    const period = periods.find((p) => p.period_code === period_code)
    if (!period) {
      throw makeOfflineError(404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.')
    }
    if (period.status === 'LOCKED') {
      throw makeOfflineError(409, 'PERIOD_LOCKED', 'This billing period is locked.')
    }

    const match = findOfflineMeterInPeriod(period_code, meter_id)
    const foundApt = match?.apt || null
    const foundMeter = match?.meter || null
    const foundMaster = foundMeter ? null : findOfflineMasterMeterInPeriod(period_code, meter_id)
    if (!foundMeter && !foundMaster) {
      throw makeOfflineError(404, 'METER_NOT_FOUND', 'Meter not found.')
    }

    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const matchingMem = foundApt
      ? userMems.find((m) => m.apartment_id === foundApt.apartment_id) || null
      : null
    const isOwnUnit = Boolean(matchingMem)
    const isPrivilegedRole = user.building_role === 'CHAIRMAN' || user.building_role === 'ACCOUNTANT'

    if (foundMaster && !isPrivilegedRole) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Chairman or Accountant may submit master meters.')
    }
    if (foundMeter && !isOwnUnit && !isPrivilegedRole) {
      if (user.building_role === 'BOARD') {
        throw makeOfflineError(403, 'FORBIDDEN', 'Board members cannot override other apartments.')
      }
      throw makeOfflineError(404, 'METER_NOT_FOUND', 'Meter not found.')
    }

    if (typeof value !== 'string' || !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(value)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid decimal meter reading.')
    }

    const meterNeedsStart = foundMeter
      ? Boolean(foundMeter.needs_start)
      : Boolean(foundMaster.needs_start)
    if (!meterNeedsStart && hasPreviousValueKey && rawPreviousValue !== undefined) {
      throw makeOfflineError(
        422,
        'PREVIOUS_VALUE_NOT_ALLOWED',
        'previous_value is only allowed for a meter without a start.',
      )
    }

    let normalizedPreviousInput = null
    if (
      meterNeedsStart &&
      hasPreviousValueKey &&
      rawPreviousValue !== null &&
      rawPreviousValue !== undefined
    ) {
      if (
        typeof rawPreviousValue !== 'string' ||
        !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(rawPreviousValue)
      ) {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid decimal previous_value.')
      }
      normalizedPreviousInput = fromBigInt3(toBigInt3(rawPreviousValue))
    }

    const normalizedVal = fromBigInt3(toBigInt3(value))
    const existingReading = foundMeter ? foundMeter.reading : foundMaster.reading
    const nextSub =
      foundMeter && foundApt
        ? computeOfflineNextSubmission(
            meter_id,
            foundApt.can_submit_readings,
            Boolean(matchingMem?.can_submit_readings),
          )
        : null

    let resolvedPreviousValue
    let previousOrigin
    if (!meterNeedsStart) {
      const storedPrev = foundMeter ? foundMeter.previous_value : foundMaster.previous_value
      resolvedPreviousValue = storedPrev ?? normalizedVal
      previousOrigin = existingReading?.previous_origin || 'HISTORY'
    } else if (normalizedPreviousInput !== null) {
      resolvedPreviousValue = normalizedPreviousInput
      previousOrigin = 'SUBMITTED'
    } else if (hasPreviousValueKey && rawPreviousValue === null) {
      resolvedPreviousValue = normalizedVal
      previousOrigin = 'START'
    } else if (existingReading && existingReading.previous_origin === 'SUBMITTED') {
      resolvedPreviousValue = existingReading.previous_value
      previousOrigin = 'SUBMITTED'
    } else {
      resolvedPreviousValue = normalizedVal
      previousOrigin = 'START'
    }

    const actingAsResident =
      Boolean(foundMeter) &&
      (!isPrivilegedRole || (isOwnUnit && nextSub?.period_code === period_code))

    if (actingAsResident) {
      if (!matchingMem?.can_submit_readings || !foundApt.can_submit_readings) {
        throw makeOfflineError(403, 'FORBIDDEN', 'You cannot submit readings for this apartment.')
      }

      if (
        existingReading &&
        existingReading.source === 'RESIDENT' &&
        existingReading.value === normalizedVal &&
        existingReading.previous_value === resolvedPreviousValue &&
        existingReading.previous_origin === previousOrigin &&
        period.status === 'OPEN_FOR_RESIDENTS'
      ) {
        return {
          reading_id: existingReading.reading_id,
          meter_id,
          period_code,
          value: existingReading.value,
          consumption_delta: existingReading.consumption_delta,
          source: existingReading.source,
          is_anomaly_confirmed: existingReading.is_anomaly_confirmed,
          previous_origin: existingReading.previous_origin,
        }
      }

      if (period.status !== 'OPEN_FOR_RESIDENTS' || !nextSub) {
        throw makeOfflineError(409, 'PERIOD_CLOSED', 'Period is closed for residents.')
      }

      if (period_code !== nextSub.period_code) {
        throw makeOfflineError(
          409,
          'WRONG_PERIOD',
          `Reading belongs to period ${nextSub.period_code}.`,
          { target_period_code: nextSub.period_code },
        )
      }

      if (existingReading?.source === 'ADMIN_OVERRIDE') {
        throw makeOfflineError(
          409,
          'READING_SET_BY_BOARD',
          'This reading was set by the board and cannot be overwritten by a resident.',
        )
      }
    } else if (period.status !== 'OPEN_FOR_RESIDENTS' && !isPrivilegedRole) {
      throw makeOfflineError(409, 'PERIOD_CLOSED', 'Period is closed for residents.')
    }

    const sortedCodes = periods.map((p) => p.period_code).sort()
    const targetIdx = sortedCodes.indexOf(period_code)
    if (targetIdx >= 0 && foundMeter) {
      for (let i = targetIdx + 1; i < sortedCodes.length; i++) {
        const newerMatch = findOfflineMeterInPeriod(sortedCodes[i], meter_id)
        if (newerMatch?.meter?.reading) {
          throw makeOfflineError(
            409,
            'LATER_READING_EXISTS',
            'A newer period already has a reading for this meter.',
          )
        }
      }
    }

    const currScaled = toBigInt3(normalizedVal)
    const prevScaled = toBigInt3(resolvedPreviousValue)
    if (previousOrigin !== 'START' && currScaled < prevScaled) {
      throw makeOfflineError(
        422,
        'READING_BELOW_PREVIOUS',
        `Value (${normalizedVal}) cannot be lower than previous reading (${resolvedPreviousValue}).`,
        { previous_value: resolvedPreviousValue, submitted_value: normalizedVal },
      )
    }

    if (existingReading && !actingAsResident && isPrivilegedRole && (!reason || !String(reason).trim())) {
      throw makeOfflineError(
        422,
        'REASON_REQUIRED',
        'A reason is required when overriding an existing meter reading.',
      )
    }

    let deltaScaled = 0n
    let isAnomaly = false
    const avgStr = foundMeter ? (foundMeter.historical_avg ?? null) : '25.000'

    if (previousOrigin !== 'START') {
      deltaScaled = currScaled - prevScaled
      if (foundMeter) {
        const thresholdScaled =
          avgStr !== null
            ? toBigInt3(avgStr) * 3n > 10000n
              ? toBigInt3(avgStr) * 3n
              : 10000n
            : defaultMeterThresholdScaled(foundMeter.resource_type, foundMeter.unit)
        isAnomaly = deltaScaled > thresholdScaled
        const deltaStrPreview = fromBigInt3(deltaScaled)

        if (isAnomaly && confirmation_level === 0) {
          throw makeOfflineError(
            409,
            'ANOMALY_CONFIRMATION_STEP_1',
            `Unusually high consumption (${deltaStrPreview} ${foundMeter.unit}).`,
            {
              submitted_value: normalizedVal,
              previous_value: resolvedPreviousValue,
              consumption_delta: deltaStrPreview,
              average_delta: avgStr,
              max_reasonable_delta: fromBigInt3(thresholdScaled),
              required_confirmation_level: 1,
            },
          )
        }

        if (isAnomaly && confirmation_level === 1) {
          throw makeOfflineError(
            409,
            'ANOMALY_CONFIRMATION_STEP_2',
            `Final confirmation required: ${deltaStrPreview} ${foundMeter.unit}.`,
            {
              submitted_value: normalizedVal,
              previous_value: resolvedPreviousValue,
              consumption_delta: deltaStrPreview,
              historical_average: avgStr,
              required_confirmation_level: 2,
            },
          )
        }
      }
    }

    const deltaStr = fromBigInt3(deltaScaled)
    const readingId =
      existingReading?.reading_id ||
      `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`
    const source = actingAsResident ? 'RESIDENT' : 'ADMIN_OVERRIDE'

    const savedSummary = {
      reading_id: readingId,
      value: normalizedVal,
      previous_value: resolvedPreviousValue,
      consumption_delta: deltaStr,
      source,
      is_anomaly_confirmed: isAnomaly,
      previous_origin: previousOrigin,
    }

    if (foundMeter) {
      foundMeter.reading = savedSummary
      if (meterNeedsStart) {
        foundMeter.previous_value = resolvedPreviousValue
      }
      if (targetIdx >= 0 && targetIdx + 1 < sortedCodes.length) {
        const nextMatch = findOfflineMeterInPeriod(sortedCodes[targetIdx + 1], meter_id)
        if (nextMatch?.meter && !nextMatch.meter.reading) {
          nextMatch.meter.previous_value = normalizedVal
          nextMatch.meter.needs_start = false
        }
      }
    } else if (foundMaster) {
      foundMaster.reading = savedSummary
      if (meterNeedsStart) {
        foundMaster.previous_value = resolvedPreviousValue
      }
      foundMaster.status = 'SUBMITTED'
      if (targetIdx >= 0 && targetIdx + 1 < sortedCodes.length) {
        const nextMaster = findOfflineMasterMeterInPeriod(sortedCodes[targetIdx + 1], meter_id)
        if (nextMaster && !nextMaster.reading) {
          nextMaster.previous_value = normalizedVal
          nextMaster.needs_start = false
        }
      }
    }

    return {
      reading_id: readingId,
      meter_id,
      period_code,
      value: normalizedVal,
      consumption_delta: deltaStr,
      source,
      is_anomaly_confirmed: isAnomaly,
      previous_origin: previousOrigin,
    }
  }

  // 6. GET /meters/readings/:id/history
  const historyMatch = pathname.match(/^\/meters\/readings\/([^/]+)\/history$/)
  if (historyMatch && method === 'GET') {
    const readingId = historyMatch[1]
    const isStaffViewer = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    let matchedAptId = null
    let matchedMeterId = null
    let matchedPeriodCode = null
    let matchedReading = null
    for (const p of getOfflinePeriods()) {
      for (const apt of getPeriodApartments(p.period_code)) {
        for (const m of apt.meters) {
          if (m.reading?.reading_id === readingId) {
            matchedAptId = apt.apartment_id
            matchedMeterId = m.meter_id
            matchedPeriodCode = p.period_code
            matchedReading = m.reading
            break
          }
        }
        if (matchedReading) break
      }
      if (matchedReading) break
    }
    const ownsReading = Boolean(
      matchedAptId && userMems.some((mem) => mem.apartment_id === matchedAptId),
    )
    if (!isStaffViewer && !ownsReading) {
      throw makeOfflineError(403, 'FORBIDDEN', 'You do not have access to this reading history.')
    }
    return {
      reading_id: readingId,
      meter_id: matchedMeterId || '018f0000-0000-7000-8000-000000000514',
      period_code: matchedPeriodCode || '2026-10',
      entries: [
        {
          changed_at: '2026-10-25T14:20:00Z',
          old_value: null,
          new_value: matchedReading?.value || '86.200',
          source: matchedReading?.source || 'RESIDENT',
          reason: null,
          changed_by: {
            display_label: 'Apt 14',
            role_badge: 'OWNER',
          },
        },
      ],
    }
  }

  // 7. GET /meters/periods/:code/matrix
  const matrixMatch = pathname.match(/^\/meters\/periods\/([^/]+)\/matrix$/)
  if (matrixMatch && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Board or Accountant role required.')
    }
    const periodCode = matrixMatch[1]
    const periods = getOfflinePeriods()
    const period = periods.find((p) => p.period_code === periodCode)
    if (!period) {
      throw makeOfflineError(404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.')
    }
    const periodApts = getPeriodApartments(period.period_code)
    const masterMeters = getPeriodMasterMeters(period.period_code)

    let coldSum = 0n
    let hotSum = 0n
    let coldStarting = 0
    let hotStarting = 0

    const apartments = periodApts.map((a) => {
      const hasMissing = a.meters.some((m) => !m.reading)
      const hasAnomaly = a.meters.some((m) => m.reading?.is_anomaly_confirmed)
      const hasEstimated = a.meters.some((m) => m.reading?.source === 'AUTO_ESTIMATED')

      let aptStatus = 'SUBMITTED'
      if (hasMissing) aptStatus = 'MISSING'
      else if (hasAnomaly) aptStatus = 'ANOMALY_CONFIRMED'
      else if (hasEstimated) aptStatus = 'AUTO_ESTIMATED'

      const meters = a.meters.map((m) => {
        if (m.reading) {
          if (m.reading.previous_origin === 'START') {
            if (m.resource_type === 'COLD_WATER') coldStarting += 1
            if (m.resource_type === 'HOT_WATER') hotStarting += 1
          } else {
            if (m.resource_type === 'COLD_WATER') coldSum += toBigInt3(m.reading.consumption_delta)
            if (m.resource_type === 'HOT_WATER') hotSum += toBigInt3(m.reading.consumption_delta)
          }
        }
        let mStatus = 'MISSING'
        if (m.reading) {
          if (m.reading.is_anomaly_confirmed) mStatus = 'ANOMALY_CONFIRMED'
          else if (m.reading.source === 'AUTO_ESTIMATED') mStatus = 'AUTO_ESTIMATED'
          else mStatus = 'SUBMITTED'
        }
        return {
          meter_id: m.meter_id,
          resource_type: m.resource_type,
          location_label: m.location_label,
          unit: m.unit,
          previous_value: m.previous_value,
          needs_start: Boolean(m.needs_start),
          status: mStatus,
          reading: m.reading ? { ...m.reading } : null,
        }
      })

      return {
        apartment_id: a.apartment_id,
        apartment_number: a.apartment_number,
        entrance: a.entrance,
        floor: a.floor,
        status: aptStatus,
        meters,
      }
    })

    const computeMasterTotal = (resourceType) => {
      const matching = masterMeters.filter((m) => m.resource_type === resourceType)
      if (matching.length === 0) return null
      let sum = 0n
      for (const mm of matching) {
        if (!mm.reading || mm.reading.previous_origin === 'START') {
          return null
        }
        sum += toBigInt3(mm.reading.consumption_delta)
      }
      return fromBigInt3(sum)
    }

    const coldMaster = computeMasterTotal('COLD_WATER')
    const hotMaster = computeMasterTotal('HOT_WATER')
    const coldAptStr = fromBigInt3(coldSum)
    const hotAptStr = fromBigInt3(hotSum)

    return {
      period: { ...period },
      balances: [
        {
          resource_type: 'COLD_WATER',
          unit: 'm3',
          master_total: coldMaster,
          apartments_sum: coldAptStr,
          unallocated_loss: coldMaster !== null ? subDecimal(coldMaster, coldAptStr) : null,
          starting_meters: coldStarting,
        },
        {
          resource_type: 'HOT_WATER',
          unit: 'm3',
          master_total: hotMaster,
          apartments_sum: hotAptStr,
          unallocated_loss: hotMaster !== null ? subDecimal(hotMaster, hotAptStr) : null,
          starting_meters: hotStarting,
        },
      ],
      master_meters: JSON.parse(JSON.stringify(masterMeters)),
      apartments,
    }
  }

  // 7b. POST /meters/periods/:code/estimate-missing (#039)
  const estimateMatch = pathname.match(/^\/meters\/periods\/([^/]+)\/estimate-missing$/)
  if (estimateMatch && method === 'POST') {
    const isStaff = ['CHAIRMAN', 'ACCOUNTANT'].includes(user.building_role)
    if (!isStaff) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman or Accountant role required.')
    }
    const periodCode = estimateMatch[1]
    const periods = getOfflinePeriods()
    const period = periods.find((p) => p.period_code === periodCode)
    if (!period) {
      throw makeOfflineError(404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.')
    }
    if (period.status !== 'REVIEW_BY_BOARD') {
      throw makeOfflineError(
        409,
        'PERIOD_NOT_IN_REVIEW',
        'Missing readings can only be auto-estimated when the period is in REVIEW_BY_BOARD.',
      )
    }
    const sortedCodes = periods.map((p) => p.period_code).sort()
    const targetIdx = sortedCodes.indexOf(period.period_code)
    const periodApts = getPeriodApartments(period.period_code)
    const estimated = []
    const skippedWithoutStart = []

    for (const apt of periodApts) {
      for (const m of apt.meters) {
        if (!m.reading) {
          if (m.needs_start || m.previous_value === null) {
            skippedWithoutStart.push(m.meter_id)
            continue
          }
          const hasLaterReading =
            targetIdx >= 0 &&
            sortedCodes
              .slice(targetIdx + 1)
              .some((laterCode) => Boolean(findOfflineMeterInPeriod(laterCode, m.meter_id)?.meter?.reading))
          if (hasLaterReading) {
            continue
          }
          const avg = m.historical_avg ?? '0.000'
          const estVal = addDecimal(m.previous_value, avg)
          const readingId = `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`
          m.reading = {
            reading_id: readingId,
            value: estVal,
            previous_value: m.previous_value,
            consumption_delta: avg,
            source: 'AUTO_ESTIMATED',
            is_anomaly_confirmed: false,
            previous_origin: 'HISTORY',
          }
          if (targetIdx >= 0 && targetIdx + 1 < sortedCodes.length) {
            const nextMatch = findOfflineMeterInPeriod(sortedCodes[targetIdx + 1], m.meter_id)
            if (nextMatch?.meter && !nextMatch.meter.reading) {
              nextMatch.meter.previous_value = estVal
              nextMatch.meter.needs_start = false
            }
          }
          estimated.push({
            reading_id: readingId,
            meter_id: m.meter_id,
            apartment_id: apt.apartment_id,
            value: estVal,
            consumption_delta: avg,
          })
        }
      }
    }

    return {
      period_code: period.period_code,
      estimated_count: estimated.length,
      estimated,
      skipped_without_start: skippedWithoutStart,
    }
  }

  // 7c. PATCH /meters/periods/:code/status (#039)
  const statusMatch = pathname.match(/^\/meters\/periods\/([^/]+)\/status$/)
  if (statusMatch && method === 'PATCH') {
    const isStaff = ['CHAIRMAN', 'ACCOUNTANT'].includes(user.building_role)
    if (!isStaff) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman or Accountant role required.')
    }
    const periodCode = statusMatch[1]
    const periods = getOfflinePeriods()
    const period = periods.find((p) => p.period_code === periodCode)
    if (!period) {
      throw makeOfflineError(404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.')
    }
    const check = validatePeriodStatusTransition(period.status, body?.status)
    if (!check.ok) {
      throw makeOfflineError(check.status, check.errorCode, check.message, check.payload || {})
    }
    const prevStatus = period.status
    period.status = check.nextStatus
    return {
      period_code: period.period_code,
      previous_status: prevStatus,
      status: period.status,
    }
  }

  // 8. GET /meters/periods/:code/export-csv
  const csvMatch = pathname.match(/^\/meters\/periods\/([^/]+)\/export-csv$/)
  if (csvMatch && method === 'GET' && raw) {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Board or Accountant role required.')
    }
    const periodCode = csvMatch[1]
    const periods = getOfflinePeriods()
    const period = periods.find((p) => p.period_code === periodCode)
    if (!period) {
      throw makeOfflineError(404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.')
    }
    const periodApts = getPeriodApartments(period.period_code)
    const masterMeters = getPeriodMasterMeters(period.period_code)
    const csv = buildPeriodCsv(period.period_code, periodApts, masterMeters)
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="readings-${period.period_code}.csv"`,
      },
    })
  }


  return UNHANDLED
}
