/**
 * calc.js — Stock and run-out date calculations
 * ===============================================
 * Pure functions only — no DOM, no DB access.
 * All dates are 'YYYY-MM-DD' strings for safe comparison.
 *
 * Intake types:
 *   daily    — taken every day; fixed dose OR variable (weeklyMedian)
 *   interval — taken once every N days (injections, long-acting meds)
 *   prn      — taken only when needed; weeklyMedian as conservative estimate
 *
 * Warning window logic:
 *   Total lead = doctorLeadDays + pharmacyDays (defaults: 14 + 7 = 21 days)
 *   The warning start is pushed EARLIER if:
 *     (a) it falls on a weekend (Sat/Sun) → moves to previous Friday
 *     (b) it falls inside a relevant doctor vacation → moves to before that vacation
 *   "Relevant" means: same doctor as the medication, or vacation has no doctor set.
 *   This is iterated until the result is stable (handles chained vacations).
 */

/* ═══════════════════════════════════════════
   Date utilities
═══════════════════════════════════════════ */

function todayStr() {
  return localDateStr(new Date());
}

/** Convert a Date to 'YYYY-MM-DD' in local time (never UTC) */
function localDateStr(d) {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Parse 'YYYY-MM-DD' to a local midnight Date */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Signed integer days from date string a to b (b − a) */
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86_400_000);
}

function inRange(d, start, end) {
  return d >= start && d <= end;
}

/* ═══════════════════════════════════════════
   Weekday / availability helpers
═══════════════════════════════════════════ */

/** True if dateStr is a Saturday or Sunday */
function isWeekend(dateStr) {
  const day = parseDate(dateStr).getDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

/**
 * True if dateStr is unavailable for a doctor/pharmacy visit:
 *   - weekend, OR
 *   - falls inside one of the relevantVacs vacation periods
 */
function isUnavailable(dateStr, relevantVacs) {
  if (isWeekend(dateStr)) return true;
  return relevantVacs.some((v) => inRange(dateStr, v.startDate, v.endDate));
}

/**
 * Walk backwards from dateStr until we find the most recent
 * available weekday not inside any relevant vacation.
 * Naturally lands on Friday when stepping back from a weekend.
 *
 * @param {string} dateStr     — starting 'YYYY-MM-DD'
 * @param {Array}  relevantVacs
 * @returns {string}           — 'YYYY-MM-DD' of nearest valid day
 */
function prevAvailableWeekday(dateStr, relevantVacs) {
  let ds    = dateStr;
  let guard = 0;
  while (isUnavailable(ds, relevantVacs) && guard++ < 120) {
    ds = localDateStr(addDays(parseDate(ds), -1));
  }
  return ds;
}

/* ═══════════════════════════════════════════
   Consumption rate
═══════════════════════════════════════════ */

/**
 * Conservative 10% buffer applied to variable/PRN meds so estimates
 * err toward "sooner" not "later". Fixed and interval meds are exact.
 */
const CONSERVATIVE = 1.10;

/**
 * Daily consumption rate for one medication.
 *
 * daily + fixed    → exactDose per day
 * daily + variable → (weeklyMedian ÷ 7) × 1.10
 * interval         → dosePerInterval ÷ intervalDays  (no buffer — schedule is exact)
 * prn              → (weeklyMedian ÷ 7) × 1.10
 *
 * Old type names (fixed, variable, as_needed) are handled for backward compat.
 */
function dailyRate(med) {
  const type = med.intakeType;

  if (type === 'daily' || type === 'fixed') {
    if (med.variableDose) {
      return ((med.weeklyMedianDose || 7) / 7) * CONSERVATIVE;
    }
    return Number(med.fixedDailyDose) || 1;
  }

  if (type === 'interval') {
    const days = Number(med.intervalDays)    || 28;
    const dose = Number(med.dosePerInterval) || 1;
    return dose / days;
  }

  // prn / as_needed / variable (legacy)
  return ((med.weeklyMedianDose || 7) / 7) * CONSERVATIVE;
}

/* ═══════════════════════════════════════════
   Effective stock
═══════════════════════════════════════════ */

/**
 * Calculates current stock for a medication.
 *
 * Starting from med.stock at med.stockDate:
 *   + adds refills logged AFTER stockDate
 *   − for each past day, subtracts:
 *       logged dose   if the user recorded an entry for that day
 *       daily rate    for every unlogged day (assumed consumption)
 *
 * This means logging a lower dose than normal INCREASES effective stock,
 * and logging zero (not taken) leaves that day's pills in the bottle.
 *
 * @param {Object} med     — medication record
 * @param {Array}  refills — refill_log records for this med
 * @param {Array}  logs    — daily_log records for this med
 * @returns {number}       — effective stock today (min 0)
 */
function effectiveStock(med, refills, logs) {
  let stock       = Number(med.stock) || 0;
  const startDate = med.stockDate || med.createdAt || todayStr();
  const todayS    = todayStr();

  // Add any refills that were recorded AFTER the stock-count snapshot
  for (const r of refills) {
    if (r.date > startDate) stock += Number(r.amount) || 0;
  }

  // Build a lookup: date → actual dose consumed that day (0 if marked "not taken")
  // Using explicit property check rather than `|| 0` so a deliberate dose of 0
  // (marked not taken) is correctly distinguished from "no log entry".
  const logMap = {};
  for (const l of logs) {
    if (l.date > startDate && l.date <= todayS) {
      // If taken=true, use the recorded dose (may be 0.5, 1, 2, …).
      // If taken=false, the user confirmed they skipped it → 0 consumed.
      logMap[l.date] = l.taken ? (Number(l.dose) || 0) : 0;
    }
  }

  // Walk every day from stockDate+1 through today, deducting consumption
  const rate = dailyRate(med);
  let   ds   = localDateStr(addDays(parseDate(startDate), 1));

  while (ds <= todayS) {
    // Prefer the actual logged value; fall back to assumed daily rate
    stock -= Object.prototype.hasOwnProperty.call(logMap, ds) ? logMap[ds] : rate;
    ds     = localDateStr(addDays(parseDate(ds), 1));
  }

  return Math.max(0, stock);
}

/* ═══════════════════════════════════════════
   Run-out prediction
═══════════════════════════════════════════ */

/**
 * Predicts the run-out date.
 * Uses Math.round so a single-pill dose change visibly shifts the date.
 *
 * @returns {string|null} 'YYYY-MM-DD' or null when not applicable
 */
function predictRunOut(stock, rate) {
  if (rate <= 0 || stock <= 0) return null;
  const daysLeft = Math.round(stock / rate); // round, not floor — more responsive
  return localDateStr(addDays(new Date(), daysLeft));
}

/* ═══════════════════════════════════════════
   Warning window
═══════════════════════════════════════════ */

/**
 * Calculates when the calendar warning should begin for a medication.
 *
 * Algorithm:
 *  1. Start with naive date = runOut − (doctorLeadDays + pharmacyDays)
 *  2. Iteratively push earlier if any relevant vacation overlaps [warnDate, runOut],
 *     landing on the day before that vacation — adjusted to a valid weekday.
 *  3. Final pass: ensure the result is itself a valid weekday outside vacation.
 *
 * Saturdays and Sundays are always unavailable (doctor's office closed).
 * Doctor vacations are filtered to those relevant for this medication's doctor.
 *
 * @param {string} runOutDate     — 'YYYY-MM-DD'
 * @param {Array}  relevantVacs   — already-filtered vacations for this med's doctor
 * @param {number} doctorLeadDays — days needed to book + attend appointment (default 14)
 * @param {number} pharmacyDays   — pharmacy delivery buffer (default 7)
 * @returns {string}              — 'YYYY-MM-DD' warning start date
 */
function warningStart(runOutDate, relevantVacs, doctorLeadDays = 14, pharmacyDays = 7) {
  const totalLead = doctorLeadDays + pharmacyDays;
  let warnStr     = localDateStr(addDays(parseDate(runOutDate), -totalLead));
  const runOutD   = parseDate(runOutDate);

  // Push warning earlier past any vacation that overlaps [warnDate, runOut]
  // Repeat until stable (handles chained/adjacent vacations).
  let changed = true;
  let guard   = 0;
  while (changed && guard++ < 120) {
    changed = false;
    for (const vac of relevantVacs) {
      const vStart = parseDate(vac.startDate);
      const vEnd   = parseDate(vac.endDate);

      // Vacation overlaps the window we care about
      if (vStart <= runOutD && vEnd >= parseDate(warnStr)) {
        // Target: the weekday immediately before this vacation starts
        const dayBeforeVac = localDateStr(addDays(vStart, -1));
        const adjusted     = prevAvailableWeekday(dayBeforeVac, relevantVacs);
        if (adjusted < warnStr) {
          warnStr = adjusted;
          changed = true;
        }
      }
    }
  }

  // Final pass: the warn date itself must be a valid weekday
  return prevAvailableWeekday(warnStr, relevantVacs);
}

/* ═══════════════════════════════════════════
   Combined status summary
═══════════════════════════════════════════ */

/**
 * Full status snapshot for one medication.
 * Used by the calendar renderer, sidebar, and med cards.
 *
 * Vacation filtering: only vacations with no doctorId, or with the same
 * doctorId as the medication, are considered relevant. A holiday for
 * Dr. A does not affect meds prescribed by Dr. B.
 *
 * @returns {{
 *   stock    : number,
 *   rate     : number,
 *   runOut   : string|null,
 *   warn     : string|null,   — calendar highlight start date
 *   daysLeft : number|null,
 *   orderBy  : string|null,   — last day to place pharmacy order (weekday-adjusted)
 * }}
 */
function medStatus(med, refills, logs, allVacations, doctorLeadDays = 14, pharmacyDays = 7) {
  // Only vacations for the same doctor (or unlinked) affect this medication
  const relevantVacs = allVacations.filter((v) =>
    !v.doctorId || !med.doctorId || v.doctorId === med.doctorId
  );

  const stock    = effectiveStock(med, refills, logs);
  const rate     = dailyRate(med);
  const runOut   = predictRunOut(stock, rate);
  const warn     = runOut ? warningStart(runOut, relevantVacs, doctorLeadDays, pharmacyDays) : null;
  const daysLeft = runOut ? daysBetween(todayStr(), runOut) : null;

  // orderBy = last safe day to place the pharmacy order (run-out minus delivery time)
  // Also adjusted to a valid weekday so it's always actionable.
  const orderByRaw = runOut ? localDateStr(addDays(parseDate(runOut), -pharmacyDays)) : null;
  const orderBy    = orderByRaw ? prevAvailableWeekday(orderByRaw, relevantVacs) : null;

  return { stock, rate, runOut, warn, daysLeft, orderBy };
}
