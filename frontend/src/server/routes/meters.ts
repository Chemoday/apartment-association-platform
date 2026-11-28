import type { SeedUser } from '../state.js';
import type { MasterMeterRow, MatrixApartment, PeriodDTO, PeriodStatus, PreviousOrigin, ReadingSource, ReadingSummary, ResourceType, SubmissionStatus } from '../../api/schema.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  DEMO_APARTMENT_CARDS,
  membershipsByUser,
  periodsMap,
  apartmentsByPeriod,
  masterMetersByPeriod,
  historyStore,
  resolveAuthorBadge,
  computeMeterNextSubmission,
  findMeterInPeriod,
  type InternalMeter,
  type InternalApartment,
} from '../state.js';
import {
  addDecimal,
  buildPeriodCsv,
  defaultMeterThresholdScaled,
  fromBigInt3,
  subDecimal,
  toBigInt3,
  validatePeriodStatusTransition,
} from '../../utils/metersMockHelpers.js';
import {
  buildApartmentConsumptionResponse,
  buildBuildingConsumptionResponse,
  parseConsumptionMonths,
} from '../../utils/consumption.js';

export async function handleMetersRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user, isBoardOrAccountant } = ctx;

    if (pathname === '/api/v1/meters/periods' && method === 'GET') {
      const sortedPeriods = Object.values(periodsMap).sort((a, b) =>
        b.period_code.localeCompare(a.period_code)
      );
      return sendJson(res, 200, { periods: sortedPeriods });
    }

    function buildMiddlewareApartmentMeters(
      cardMeta: (typeof DEMO_APARTMENT_CARDS)[number],
      sortedPeriods: PeriodDTO[],
    ) {
      const exactApt = apartmentsByPeriod['2026-10'].find(
        (a) => a.apartment_id === cardMeta.apartment_id,
      );
      if (!exactApt && (cardMeta.apartment_kind || 'APARTMENT') !== 'APARTMENT') {
        return [];
      }
      const baseApt = exactApt || apartmentsByPeriod['2026-10'][0];

      const metersHistory = baseApt.meters.map((baseMeter, mIdx) => {
        const readings: {
          period_code: string;
          reading_id: string;
          value: string;
          consumption_delta: string;
          source: ReadingSource;
          is_anomaly_confirmed: boolean;
          previous_origin: PreviousOrigin;
        }[] = [];

        for (const p of sortedPeriods) {
          const periodApt = (apartmentsByPeriod[p.period_code] || []).find(
            (a) => a.apartment_id === baseApt.apartment_id
          );
          const periodMeter = periodApt?.meters.find((m) => m.meter_id === baseMeter.meter_id);
          if (periodMeter?.reading) {
            const isEstimatedSample = p.period_code === '2026-08' && mIdx === 0;
            const isAnomalySample =
              periodMeter.reading.is_anomaly_confirmed ||
              (p.period_code === '2026-09' && baseApt.apartment_number === '14' && mIdx === 0);
            readings.push({
              period_code: p.period_code,
              reading_id: periodMeter.reading.reading_id,
              value: periodMeter.reading.value,
              consumption_delta: periodMeter.reading.consumption_delta,
              source: isEstimatedSample ? 'AUTO_ESTIMATED' : periodMeter.reading.source,
              is_anomaly_confirmed: isAnomalySample,
              previous_origin: periodMeter.reading.previous_origin || 'HISTORY',
            });
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
        };
      });

      // Add a replaced meter sample on Apt 14 so the replaced-meter label is visible
      if (cardMeta.apartment_number === '14' && (cardMeta.apartment_kind || 'APARTMENT') === 'APARTMENT') {
        metersHistory.push({
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
        });
      }

      return metersHistory;
    }

    function safeDecodePathSegment(raw: string): string {
      try {
        return decodeURIComponent(raw);
      } catch {
        return '';
      }
    }

    // 3c. GET /api/v1/meters/apartments/{apartment_id}/readings (E8/P1)
    const aptReadingsMatch = pathname.match(/^\/api\/v1\/meters\/apartments\/([^/]+)\/readings$/);
    if (aptReadingsMatch && method === 'GET') {
      const aptId = safeDecodePathSegment(aptReadingsMatch[1]);
      const cardMeta = aptId ? DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === aptId) : undefined;
      const userMems = membershipsByUser[user.user_id] || [];
      const isOwnApartment = Boolean(aptId) && userMems.some((m) => m.apartment_id === aptId);
      if (!cardMeta || (!isBoardOrAccountant && !isOwnApartment)) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }

      const sortedPeriods = Object.values(periodsMap).sort((a, b) =>
        b.period_code.localeCompare(a.period_code)
      );

      return sendJson(res, 200, {
        apartment_id: cardMeta.apartment_id,
        apartment_number: cardMeta.apartment_number,
        apartment_kind: cardMeta.apartment_kind || 'APARTMENT',
        periods: sortedPeriods,
        meters: buildMiddlewareApartmentMeters(cardMeta, sortedPeriods),
      });
    }

    // 3d. GET /api/v1/meters/apartments/{apartment_id}/consumption (#030)
    const aptConsumptionMatch = pathname.match(/^\/api\/v1\/meters\/apartments\/([^/]+)\/consumption$/);
    if (aptConsumptionMatch && method === 'GET') {
      const aptId = safeDecodePathSegment(aptConsumptionMatch[1]);
      const cardMeta = aptId ? DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === aptId) : undefined;
      const userMems = membershipsByUser[user.user_id] || [];
      const isOwnApartment = Boolean(aptId) && userMems.some((m) => m.apartment_id === aptId);
      if (!cardMeta || (!isBoardOrAccountant && !isOwnApartment)) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }

      const parsedMonths = parseConsumptionMonths(urlObj.searchParams.get('months'));
      if (!parsedMonths.ok) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          parsedMonths.message || 'months must be between 1 and 24.'
        );
      }

      const sortedPeriods = Object.values(periodsMap).sort((a, b) =>
        b.period_code.localeCompare(a.period_code)
      );
      const metersHistory = buildMiddlewareApartmentMeters(cardMeta, sortedPeriods);

      return sendJson(
        res,
        200,
        buildApartmentConsumptionResponse({
          apartmentId: cardMeta.apartment_id,
          apartmentNumber: cardMeta.apartment_number,
          apartmentKind: cardMeta.apartment_kind || 'APARTMENT',
          periods: sortedPeriods,
          meters: metersHistory,
          months: parsedMonths.months,
        })
      );
    }

    // 3e. GET /api/v1/meters/consumption (#031) - staff only (CHAIRMAN, BOARD, ACCOUNTANT)
    if (pathname === '/api/v1/meters/consumption' && method === 'GET') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman, Board, or Accountant role required.');
      }

      const parsedMonths = parseConsumptionMonths(urlObj.searchParams.get('months'));
      if (!parsedMonths.ok) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          parsedMonths.message || 'months must be between 1 and 24.'
        );
      }

      const sortedPeriods = Object.values(periodsMap).sort((a, b) =>
        b.period_code.localeCompare(a.period_code)
      );
      const apartmentsPayload = (apartmentsByPeriod['2026-10'] || []).map((baseApt) => {
        const cardMeta = DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === baseApt.apartment_id);
        return {
          apartment_id: baseApt.apartment_id,
          area_m2: cardMeta?.area_m2 ?? null,
          meters: cardMeta ? buildMiddlewareApartmentMeters(cardMeta, sortedPeriods) : [],
        };
      });

      return sendJson(
        res,
        200,
        buildBuildingConsumptionResponse({
          periods: sortedPeriods,
          apartments: apartmentsPayload,
          months: parsedMonths.months,
        })
      );
    }

    // 4. GET /api/v1/meters/my-dashboard
    if (pathname === '/api/v1/meters/my-dashboard' && method === 'GET') {
      const requestedPeriodCode = urlObj.searchParams.get('period_code');
      const userMems = membershipsByUser[user.user_id] || [];
      const userAptIds = new Set(userMems.map((m) => m.apartment_id));
      const memByAptId = new Map(userMems.map((m) => [m.apartment_id, m]));

      // Determine default period without period_code: P ('2026-10') while any meter still goes to P, else M ('2026-11')
      let periodCode = requestedPeriodCode;
      if (!periodCode) {
        const refApts = apartmentsByPeriod['2026-10'] || [];
        let hasPendingPrev = false;
        for (const a of refApts) {
          if (!userAptIds.has(a.apartment_id)) continue;
          const memCanSubmit = Boolean(memByAptId.get(a.apartment_id)?.can_submit_readings);
          for (const m of a.meters) {
            const sub = computeMeterNextSubmission(m.meter_id, a.can_submit_readings, memCanSubmit);
            if (sub?.period_code === '2026-10') {
              hasPendingPrev = true;
              break;
            }
          }
          if (hasPendingPrev) break;
        }
        periodCode = hasPendingPrev ? '2026-10' : '2026-11';
      }

      const period = periodsMap[periodCode] || periodsMap['2026-10'];
      const periodApts = apartmentsByPeriod[period.period_code] || apartmentsByPeriod['2026-10'];
      const periodAptById = new Map(periodApts.map((a) => [a.apartment_id, a]));

      const baseCanSubmitByAptId = new Map(
        (apartmentsByPeriod['2026-10'] || []).map((a) => [
          a.apartment_id,
          Boolean(a.can_submit_readings),
        ])
      );

      const apartments = userMems.map((mem) => {
        const a = periodAptById.get(mem.apartment_id);
        const memCanSubmit = Boolean(mem.can_submit_readings);
        if (!a) {
          return {
            apartment_id: mem.apartment_id,
            apartment_number: mem.apartment_number,
            apartment_kind: mem.apartment_kind || 'APARTMENT',
            can_submit_readings: memCanSubmit,
            meters: [],
          };
        }
        const baseAptCanSubmit = baseCanSubmitByAptId.get(a.apartment_id) ?? false;
        return {
          apartment_id: a.apartment_id,
          apartment_number: a.apartment_number,
          apartment_kind: a.apartment_kind || mem.apartment_kind || 'APARTMENT',
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
            next_submission: computeMeterNextSubmission(
              m.meter_id,
              baseAptCanSubmit,
              memCanSubmit
            ),
          })),
        };
      });

      return sendJson(res, 200, {
        period,
        apartments,
      });
    }

    // 5. POST /api/v1/meters/readings
    if (pathname === '/api/v1/meters/readings' && method === 'POST') {
      const body = await readBody(req);
      const meter_id = typeof body.meter_id === 'string' ? body.meter_id : '';
      const period_code = typeof body.period_code === 'string' && body.period_code ? body.period_code : '2026-10';
      const value = body.value;
      const confirmation_level = typeof body.confirmation_level === 'number' ? body.confirmation_level : 0;
      const reason = typeof body.reason === 'string' ? body.reason : null;
      const hasPreviousValueKey = Object.prototype.hasOwnProperty.call(body, 'previous_value');
      const rawPreviousValue = hasPreviousValueKey ? body.previous_value : undefined;

      const period = periodsMap[period_code];
      if (!period) {
        return sendError(res, 404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.');
      }
      if (period.status === 'LOCKED') {
        return sendError(res, 409, 'PERIOD_LOCKED', 'This billing period is locked.');
      }

      const periodApts = apartmentsByPeriod[period_code] || [];
      const masterMeters = masterMetersByPeriod[period_code] || [];

      let foundMeter: InternalMeter | null = null;
      let foundApt: InternalApartment | null = null;
      let foundMaster: MasterMeterRow | null = null;

      for (const apt of periodApts) {
        const m = apt.meters.find((item) => item.meter_id === meter_id);
        if (m) {
          foundMeter = m;
          foundApt = apt;
          break;
        }
      }

      if (!foundMeter) {
        foundMaster = masterMeters.find((m) => m.meter_id === meter_id) || null;
      }

      if (!foundMeter && !foundMaster) {
        return sendError(res, 404, 'METER_NOT_FOUND', 'Meter not found.');
      }

      const userMems = membershipsByUser[user.user_id] || [];
      const matchingMem = foundApt
        ? userMems.find((m) => m.apartment_id === foundApt!.apartment_id)
        : null;
      const isOwnUnit = Boolean(matchingMem);
      const isPrivilegedRole = user.building_role === 'CHAIRMAN' || user.building_role === 'ACCOUNTANT';

      if (foundMaster && !isPrivilegedRole) {
        return sendError(res, 403, 'FORBIDDEN', 'Only Chairman or Accountant may submit master meters.');
      }
      if (foundMeter && !isOwnUnit && !isPrivilegedRole) {
        if (user.building_role === 'BOARD') {
          return sendError(res, 403, 'FORBIDDEN', 'Board members cannot override other apartments.');
        }
        return sendError(res, 404, 'METER_NOT_FOUND', 'Meter not found.');
      }

      if (typeof value !== 'string' || !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(value)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid decimal meter reading.');
      }

      const meterNeedsStart = foundMeter
        ? Boolean(foundMeter.needs_start)
        : Boolean(foundMaster!.needs_start);

      if (!meterNeedsStart && hasPreviousValueKey && rawPreviousValue !== undefined) {
        return sendError(
          res,
          422,
          'PREVIOUS_VALUE_NOT_ALLOWED',
          'previous_value is only allowed for a meter without a start.'
        );
      }

      let normalizedPreviousInput: string | null = null;
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
          return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid decimal previous_value.');
        }
        normalizedPreviousInput = fromBigInt3(toBigInt3(rawPreviousValue));
      }

      const normalizedVal = fromBigInt3(toBigInt3(value));
      const existingReading = foundMeter ? foundMeter.reading : foundMaster!.reading;

      let resolvedPreviousValue: string;
      let previousOrigin: PreviousOrigin;
      if (!meterNeedsStart) {
        const storedPrev = foundMeter ? foundMeter.previous_value : foundMaster!.previous_value;
        resolvedPreviousValue = storedPrev ?? normalizedVal;
        previousOrigin = existingReading?.previous_origin || 'HISTORY';
      } else if (normalizedPreviousInput !== null) {
        resolvedPreviousValue = normalizedPreviousInput;
        previousOrigin = 'SUBMITTED';
      } else if (hasPreviousValueKey && rawPreviousValue === null) {
        resolvedPreviousValue = normalizedVal;
        previousOrigin = 'START';
      } else if (existingReading && existingReading.previous_origin === 'SUBMITTED') {
        resolvedPreviousValue = existingReading.previous_value;
        previousOrigin = 'SUBMITTED';
      } else {
        resolvedPreviousValue = normalizedVal;
        previousOrigin = 'START';
      }

      const nextSub = foundMeter && foundApt
        ? computeMeterNextSubmission(
            meter_id,
            foundApt.can_submit_readings,
            Boolean(matchingMem?.can_submit_readings)
          )
        : null;

      // Resident mode applies to non-privileged users, OR to Chairman/Accountant submitting on own unit's target period
      const actingAsResident =
        Boolean(foundMeter) &&
        (!isPrivilegedRole || (isOwnUnit && nextSub?.period_code === period_code));

      if (actingAsResident) {
        if (!matchingMem?.can_submit_readings || !foundApt?.can_submit_readings) {
          return sendError(res, 403, 'FORBIDDEN', 'You cannot submit readings for this apartment.');
        }

        // Idempotent retry of own reading in an open period
        if (
          existingReading &&
          existingReading.source === 'RESIDENT' &&
          existingReading.value === normalizedVal &&
          existingReading.previous_value === resolvedPreviousValue &&
          existingReading.previous_origin === previousOrigin &&
          period.status === 'OPEN_FOR_RESIDENTS'
        ) {
          return sendJson(res, 200, {
            reading_id: existingReading.reading_id,
            meter_id,
            period_code,
            value: existingReading.value,
            consumption_delta: existingReading.consumption_delta,
            source: existingReading.source,
            is_anomaly_confirmed: existingReading.is_anomaly_confirmed,
            previous_origin: existingReading.previous_origin,
          });
        }

        if (period.status !== 'OPEN_FOR_RESIDENTS') {
          return sendError(res, 409, 'PERIOD_CLOSED', 'Period is closed for residents.');
        }

        if (!nextSub) {
          return sendError(res, 409, 'PERIOD_CLOSED', 'Submission for this meter is closed.');
        }

        if (period_code !== nextSub.period_code) {
          return sendError(
            res,
            409,
            'WRONG_PERIOD',
            `Reading belongs to period ${nextSub.period_code}.`,
            { target_period_code: nextSub.period_code }
          );
        }

        if (existingReading?.source === 'ADMIN_OVERRIDE') {
          return sendError(
            res,
            409,
            'READING_SET_BY_BOARD',
            'This reading was set by the board and cannot be overwritten by a resident.'
          );
        }
      } else {
        if (period.status !== 'OPEN_FOR_RESIDENTS' && !isPrivilegedRole) {
          return sendError(res, 409, 'PERIOD_CLOSED', 'Period is closed for residents.');
        }
      }

      // Check LATER_READING_EXISTS (cannot modify a period when a newer period already has a reading)
      const sortedPeriodCodes = Object.keys(periodsMap).sort();
      const targetIdx = sortedPeriodCodes.indexOf(period_code);
      if (targetIdx >= 0 && foundMeter) {
        for (let i = targetIdx + 1; i < sortedPeriodCodes.length; i++) {
          const newerMeter = findMeterInPeriod(sortedPeriodCodes[i], meter_id);
          if (newerMeter?.reading) {
            return sendError(
              res,
              409,
              'LATER_READING_EXISTS',
              'A newer period already has a reading for this meter.'
            );
          }
        }
      }

      const prevScaled = toBigInt3(resolvedPreviousValue);
      const currScaled = toBigInt3(normalizedVal);

      if (previousOrigin !== 'START' && currScaled < prevScaled) {
        return sendError(
          res,
          422,
          'READING_BELOW_PREVIOUS',
          `Value (${normalizedVal}) cannot be lower than previous reading (${resolvedPreviousValue}).`,
          { previous_value: resolvedPreviousValue, submitted_value: normalizedVal }
        );
      }

      if (
        existingReading &&
        !actingAsResident &&
        isPrivilegedRole &&
        (!reason || !String(reason).trim())
      ) {
        return sendError(
          res,
          422,
          'REASON_REQUIRED',
          'A reason is required when overriding an existing meter reading.'
        );
      }

      let deltaScaled = 0n;
      let isAnomaly = false;
      const avgStr = foundMeter ? (foundMeter.historical_avg ?? null) : '25.000';

      if (previousOrigin !== 'START') {
        deltaScaled = currScaled - prevScaled;
        if (foundMeter) {
          const thresholdScaled =
            avgStr !== null
              ? toBigInt3(avgStr) * 3n > 10000n
                ? toBigInt3(avgStr) * 3n
                : 10000n
              : defaultMeterThresholdScaled(foundMeter.resource_type, foundMeter.unit);
          isAnomaly = deltaScaled > thresholdScaled;
          const deltaStrPreview = fromBigInt3(deltaScaled);

          if (isAnomaly && confirmation_level === 0) {
            return sendError(
              res,
              409,
              'ANOMALY_CONFIRMATION_STEP_1',
              `Unusually high consumption (${deltaStrPreview} ${foundMeter.unit}). Please verify the reading on your meter.`,
              {
                submitted_value: normalizedVal,
                previous_value: resolvedPreviousValue,
                consumption_delta: deltaStrPreview,
                average_delta: avgStr,
                max_reasonable_delta: fromBigInt3(thresholdScaled),
                required_confirmation_level: 1,
              }
            );
          }

          if (isAnomaly && confirmation_level === 1) {
            return sendError(
              res,
              409,
              'ANOMALY_CONFIRMATION_STEP_2',
              `Final confirmation required: ${deltaStrPreview} ${foundMeter.unit} will be billed to your apartment.`,
              {
                submitted_value: normalizedVal,
                previous_value: resolvedPreviousValue,
                consumption_delta: deltaStrPreview,
                historical_average: avgStr,
                required_confirmation_level: 2,
              }
            );
          }
        }
      }

      const deltaStr = fromBigInt3(deltaScaled);
      const oldVal = existingReading?.value || null;
      const readingId =
        existingReading?.reading_id ||
        `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`;
      const source: ReadingSource = actingAsResident ? 'RESIDENT' : 'ADMIN_OVERRIDE';

      const newReading: ReadingSummary = {
        reading_id: readingId,
        value: normalizedVal,
        previous_value: resolvedPreviousValue,
        consumption_delta: deltaStr,
        source,
        is_anomaly_confirmed: isAnomaly,
        previous_origin: previousOrigin,
      };

      if (foundMeter) {
        foundMeter.reading = newReading;
        if (meterNeedsStart) {
          foundMeter.previous_value = resolvedPreviousValue;
        }
        // Propagate new reading value to the subsequent period's previous_value if it has no reading yet
        const nextIdx = targetIdx + 1;
        if (nextIdx > 0 && nextIdx < sortedPeriodCodes.length) {
          const nextMeter = findMeterInPeriod(sortedPeriodCodes[nextIdx], meter_id);
          if (nextMeter && !nextMeter.reading) {
            nextMeter.previous_value = normalizedVal;
            nextMeter.needs_start = false;
          }
        }
      } else if (foundMaster) {
        foundMaster.reading = newReading;
        if (meterNeedsStart) {
          foundMaster.previous_value = resolvedPreviousValue;
        }
        foundMaster.status = 'SUBMITTED';
        const nextIdx = targetIdx + 1;
        if (nextIdx > 0 && nextIdx < sortedPeriodCodes.length) {
          const nextMasters = masterMetersByPeriod[sortedPeriodCodes[nextIdx]] || [];
          const nextMaster = nextMasters.find((item) => item.meter_id === meter_id);
          if (nextMaster && !nextMaster.reading) {
            nextMaster.previous_value = normalizedVal;
            nextMaster.needs_start = false;
          }
        }
      }

      if (!historyStore[readingId]) {
        historyStore[readingId] = {
          meter_id,
          period_code,
          entries: [],
        };
      }
      historyStore[readingId].entries.unshift({
        changed_at: new Date().toISOString(),
        old_value: oldVal,
        new_value: normalizedVal,
        source,
        reason: reason || null,
        changed_by: resolveAuthorBadge(user.user_id),
      });

      return sendJson(res, 200, {
        reading_id: readingId,
        meter_id,
        period_code,
        value: normalizedVal,
        consumption_delta: deltaStr,
        source,
        is_anomaly_confirmed: isAnomaly,
        previous_origin: previousOrigin,
      });
    }

    // 6. GET /api/v1/meters/readings/{reading_id}/history
    const historyMatch = pathname.match(/^\/api\/v1\/meters\/readings\/([^/]+)\/history$/);
    if (historyMatch && method === 'GET') {
      const readingId = historyMatch[1];
      const userMems = membershipsByUser[user.user_id] || [];
      let matchedAptId: string | null = null;
      for (const code of Object.keys(apartmentsByPeriod)) {
        for (const apt of apartmentsByPeriod[code] || []) {
          if (apt.meters.some((m) => m.reading?.reading_id === readingId)) {
            matchedAptId = apt.apartment_id;
            break;
          }
        }
        if (matchedAptId) break;
      }
      const ownsReading = Boolean(
        matchedAptId && userMems.some((mem) => mem.apartment_id === matchedAptId),
      );
      if (!isBoardOrAccountant && !ownsReading) {
        return sendError(res, 403, 'FORBIDDEN', 'You do not have access to this reading history.');
      }
      const hist = historyStore[readingId] || {
        meter_id: '018f0000-0000-7000-8000-000000000514',
        period_code: '2026-10',
        entries: [
          {
            changed_at: '2026-10-25T14:20:00Z',
            old_value: null,
            new_value: '86.200',
            source: 'RESIDENT',
            reason: null,
            changed_by: {
              display_label: 'Apt 14',
              role_badge: 'OWNER',
            },
          },
        ],
      };
      return sendJson(res, 200, {
        reading_id: readingId,
        meter_id: hist.meter_id,
        period_code: hist.period_code,
        entries: hist.entries,
      });
    }

    // 7. GET /api/v1/meters/periods/{period_code}/matrix
    const matrixMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/matrix$/);
    if (matrixMatch && method === 'GET') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Board or Accountant role required.');
      }
      const periodCode = matrixMatch[1];
      const rawKind = urlObj.searchParams.get('kind');
      const kindFilter = rawKind ? rawKind.trim().toUpperCase() : '';
      if (kindFilter && !['APARTMENT', 'PARKING', 'GARAGE'].includes(kindFilter)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid object kind filter.');
      }
      const period = periodsMap[periodCode];
      if (!period) {
        return sendError(res, 404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.');
      }
      const periodApts = apartmentsByPeriod[periodCode] || [];
      const masterMeters = masterMetersByPeriod[periodCode] || [];

      let coldSum = 0n;
      let hotSum = 0n;
      let coldStarting = 0;
      let hotStarting = 0;

      const apartments: MatrixApartment[] = periodApts.map((a) => {
        const hasMissing = a.meters.some((m) => !m.reading);
        const hasAnomaly = a.meters.some((m) => m.reading?.is_anomaly_confirmed);
        const hasEstimated = a.meters.some((m) => m.reading?.source === 'AUTO_ESTIMATED');

        let aptStatus: SubmissionStatus = 'SUBMITTED';
        if (hasMissing) aptStatus = 'MISSING';
        else if (hasAnomaly) aptStatus = 'ANOMALY_CONFIRMED';
        else if (hasEstimated) aptStatus = 'AUTO_ESTIMATED';

        const meters = a.meters.map((m) => {
          if (m.reading) {
            if (m.reading.previous_origin === 'START') {
              if (m.resource_type === 'COLD_WATER') coldStarting += 1;
              if (m.resource_type === 'HOT_WATER') hotStarting += 1;
            } else {
              if (m.resource_type === 'COLD_WATER') coldSum += toBigInt3(m.reading.consumption_delta);
              if (m.resource_type === 'HOT_WATER') hotSum += toBigInt3(m.reading.consumption_delta);
            }
          }
          let mStatus: SubmissionStatus = 'MISSING';
          if (m.reading) {
            if (m.reading.is_anomaly_confirmed) mStatus = 'ANOMALY_CONFIRMED';
            else if (m.reading.source === 'AUTO_ESTIMATED') mStatus = 'AUTO_ESTIMATED';
            else mStatus = 'SUBMITTED';
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
          };
        });

        return {
          apartment_id: a.apartment_id,
          apartment_number: a.apartment_number,
          apartment_kind: a.apartment_kind || 'APARTMENT',
          entrance: a.entrance,
          floor: a.floor,
          status: aptStatus,
          meters,
        };
      });

      const computeMasterTotal = (resourceType: ResourceType): string | null => {
        const matching = masterMeters.filter((m) => m.resource_type === resourceType);
        if (matching.length === 0) return null;
        let sum = 0n;
        for (const mm of matching) {
          if (!mm.reading || mm.reading.previous_origin === 'START') {
            return null;
          }
          sum += toBigInt3(mm.reading.consumption_delta);
        }
        return fromBigInt3(sum);
      };

      const coldMaster = computeMasterTotal('COLD_WATER');
      const hotMaster = computeMasterTotal('HOT_WATER');

      const coldAptStr = fromBigInt3(coldSum);
      const hotAptStr = fromBigInt3(hotSum);

      return sendJson(res, 200, {
        period,
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
        master_meters: masterMeters,
        apartments: kindFilter
          ? apartments.filter((a) => (a.apartment_kind || 'APARTMENT') === kindFilter)
          : apartments,
      });
    }

    // 8. POST /api/v1/meters/periods/{period_code}/estimate-missing
    const estimateMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/estimate-missing$/);
    if (estimateMatch && method === 'POST') {
      if (user.building_role !== 'CHAIRMAN' && user.building_role !== 'ACCOUNTANT') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman or Accountant role required.');
      }
      const periodCode = estimateMatch[1];
      const period = periodsMap[periodCode];
      if (!period) {
        return sendError(res, 404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.');
      }
      if (period.status !== 'REVIEW_BY_BOARD') {
        return sendError(
          res,
          409,
          'PERIOD_NOT_IN_REVIEW',
          'Missing readings can only be auto-estimated when the period is in REVIEW_BY_BOARD.',
        );
      }
      const sortedPeriodCodes = Object.keys(apartmentsByPeriod).sort();
      const targetIdx = sortedPeriodCodes.indexOf(periodCode);
      const periodApts = apartmentsByPeriod[periodCode] || [];
      const estimated: Array<{
        reading_id: string;
        meter_id: string;
        apartment_id: string;
        value: string;
        consumption_delta: string;
      }> = [];
      const skippedWithoutStart: string[] = [];

      for (const apt of periodApts) {
        for (const m of apt.meters) {
          if (!m.reading) {
            if (m.needs_start || m.previous_value === null) {
              skippedWithoutStart.push(m.meter_id);
              continue;
            }
            const hasLaterReading =
              targetIdx >= 0 &&
              sortedPeriodCodes
                .slice(targetIdx + 1)
                .some((laterCode) => Boolean(findMeterInPeriod(laterCode, m.meter_id)?.reading));
            if (hasLaterReading) {
              continue;
            }
            const avg = m.historical_avg ?? '0.000';
            const estVal = addDecimal(m.previous_value, avg);
            const readingId = `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`;
            m.reading = {
              reading_id: readingId,
              value: estVal,
              previous_value: m.previous_value,
              consumption_delta: avg,
              source: 'AUTO_ESTIMATED',
              is_anomaly_confirmed: false,
              previous_origin: 'HISTORY',
            };
            if (targetIdx >= 0 && targetIdx + 1 < sortedPeriodCodes.length) {
              const nextMeter = findMeterInPeriod(sortedPeriodCodes[targetIdx + 1], m.meter_id);
              if (nextMeter && !nextMeter.reading) {
                nextMeter.previous_value = estVal;
                nextMeter.needs_start = false;
              }
            }
            estimated.push({
              reading_id: readingId,
              meter_id: m.meter_id,
              apartment_id: apt.apartment_id,
              value: estVal,
              consumption_delta: avg,
            });
          }
        }
      }

      return sendJson(res, 200, {
        period_code: periodCode,
        estimated_count: estimated.length,
        estimated,
        skipped_without_start: skippedWithoutStart,
      });
    }

    // 9. PATCH /api/v1/meters/periods/{period_code}/status
    const statusMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/status$/);
    if (statusMatch && method === 'PATCH') {
      if (user.building_role !== 'CHAIRMAN' && user.building_role !== 'ACCOUNTANT') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman or Accountant role required.');
      }
      const periodCode = statusMatch[1];
      const period = periodsMap[periodCode];
      if (!period) {
        return sendError(res, 404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.');
      }
      const body = await readBody(req);
      const check = validatePeriodStatusTransition(period.status, body?.status);
      if (!check.ok) {
        return sendError(
          res,
          check.status,
          check.errorCode,
          check.message,
          'payload' in check ? check.payload : undefined,
        );
      }
      const prevStatus = period.status;
      period.status = check.nextStatus as PeriodStatus;
      return sendJson(res, 200, {
        period_code: periodCode,
        previous_status: prevStatus,
        status: period.status,
      });
    }

    // 10. GET /api/v1/meters/periods/{period_code}/export-csv
    const csvMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/export-csv$/);
    if (csvMatch && method === 'GET') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Board or Accountant role required.');
      }
      const periodCode = csvMatch[1];
      const period = periodsMap[periodCode];
      if (!period) {
        return sendError(res, 404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.');
      }
      const periodApts = apartmentsByPeriod[periodCode] || [];
      const masterMeters = masterMetersByPeriod[periodCode] || [];
      const csv = buildPeriodCsv(periodCode, periodApts, masterMeters);
      const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="readings-${periodCode}.csv"`);
      res.setHeader('X-Trace-Id', traceId);
      { res.end(csv); return true; }
    }

    // 11. GET /api/v1/communication/emergencies/active

  return false;
}
