/**
 * calc.js — Stock and run-out date calculations
 * ===============================================
 * Pure functions only — no DOM, no DB access.
 * All dates are 'YYYY-MM-DD' strings for safe comparison.
 *
 * Intake types:
 *   daily    — taken every day; fixed dose OR variable (weeklyMedian used)
 *   interval — taken once every N days (injections, long-acting meds)
 *   prn      — taken only when needed; weeklyMedian as conservative estimate
 *
 * Warning window logic:
 *   Total lead = doctorLeadDays + pharmacyDays (defaults: 14 + 7 = 21)
 *   The window is pushed EARLIER if any relevant vacation overlaps it,
 *   so the refill window never falls inside a vacation.
 *   Only vacations linked to the same doctor as the medication are relevant.
 */

/* ═══════════════════════════════════════════
   Date utilities
═══════════════════════════════════════════ */

function todayStr() {
  return localDateStr(new Date());
}

/** Convert a Date to 'YYYY-MM-DD' in local time (not UTC) */
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

/** Signed days from date string a to date string b (b − a) */
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86_400_000);
}

function inRange(d, start, end) {
  return d >= start && d <= end;
}

/* ═══════════════════════════════════════════
   Consumption rate
═══════════════════════════════════════════ */

/**
 * Conservative factor: variable/prn meds tend to run out faster than
 * the median estimate, so we assume 10% higher consumption.
 * Fixed and interval meds are exact — no buffer needed.
 */
const CONSERVATIVE = 1.10;

/**
 * Daily consumption rate for one medication.
 *
 * daily + fixed    → exactDose per day (no buffer)
 * daily + variable → weeklyMedian ÷ 7 × 1.10
 * interval         → dosePerInterval ÷ intervalDays (no buffer — schedule is exact)
 * prn              → weeklyMedian ÷ 7 × 1.10
 *
 * Backward-compatible with old type names (fixed, variable, as_needed).
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
    const days = Number(med.intervalDays)      || 28;
    const dose = Number(med.dosePerInterval)   || 1;
    return dose / days;
  }

  if (type === 'prn' || type === 'as_needed' || type === 'variable') {
    return ((med.weeklyMedianDose || 7) / 7) * CONSERVATIVE;
  }

  return 0;
}

/* ═══════════════════════════════════════════
   Effective stock
═══════════════════════════════════════════ */

/**
 * Calculates current stock for a medication.
 *
 * Starting from med.stock at med.stockDate:
 *   + adds refills logged after stockDate
 *   − subtracts actual logged doses for each logged day
 *   − subtracts assumed daily rate for each unlogged past day
 *
 * @param {Object} med     — medication record
 * @param {Array}  refills — refill_log records for this med
 * @param {Array}  logs    — daily_log records for this med
 * @returns {number}       — effective stock as of today (min 0)
 */
function effectiveStock(med, refills, logs) {
  let stock       = Number(med.stock)    || 0;
  const startDate = med.stockDate;
  const todayS    = todayStr();

  // Add any refills recorded after the snapshot date
  refills
    .filter((r) => r.date > startDate)
    .forEach((r) => { stock += Number(r.amount) || 0; });

  // Build a fast lookup: date → logged dose
  const logMap = {};
  logs
    .filter((l) => l.date > startDate && l.date <= todayS)
    .forEach((l) => { logMap[l.date] = Number(l.dose) || 0; });

  // Walk every day from stockDate+1 through today
  const rate  = dailyRate(med);
  let cursor  = addDays(parseDate(startDate), 1);
  const end   = parseDate(todayS);

  while (cursor <= end) {
    const ds = localDateStr(cursor);
    stock   -= (ds in logMap) ? logMap[ds] : rate;
    cursor   = addDays(cursor, 1);
  }

  return Math.max(0, stock);
}

/* ═══════════════════════════════════════════
   Run-out prediction
═══════════════════════════════════════════ */

/**
 * @param {number} stock — effective current stock
 * @param {number} rate  — daily consumption rate
 * @returns {string|null} — 'YYYY-MM-DD' or null when not applicable
 */
function predictRunOut(stock, rate) {
  if (rate <= 0 || stock <= 0) return null;
  const daysLeft = Math.floor(stock / rate);
  return localDateStr(addDays(new Date(), daysLeft));
}

/* ═══════════════════════════════════════════
   Warning window
═══════════════════════════════════════════ */

/**
 * Calculates when calendar highlighting should begin for a medication.
 *
 * Total lead time = doctorLeadDays + pharmacyDays
 *   doctorLeadDays — time needed to book and attend appointment
 *   pharmacyDays   — time for pharmacy to fill and deliver prescription
 *
 * Vacation-avoidance: if any relevant vacation overlaps the warning window,
 * the warning is pushed EARLIER (to the day before that vacation) so the
 * refill window never falls inside a vacation period.
 * This repeats until stable (handles chained vacations).
 *
 * @param {string} runOutDate      — 'YYYY-MM-DD'
 * @param {Array}  relevantVacs    — pre-filtered vacations for this med's doctor
 * @param {number} doctorLeadDays  — days needed to get prescription (default 14)
 * @param {number} pharmacyDays    — pharmacy delivery buffer (default 7)
 * @returns {string}               — 'YYYY-MM-DD' warning start date
 */
function warningStart(runOutDate, relevantVacs, doctorLeadDays = 14, pharmacyDays = 7) {
  const totalLead = doctorLeadDays + pharmacyDays;
  let warnDate    = addDays(parseDate(runOutDate), -totalLead);
  const runOut    = parseDate(runOutDate);

  // Push warning before any overlapping vacation — repeat until stable
  let changed = true;
  let guard   = 0;
  while (changed && guard++ < 30) {
    changed = false;
    for (const vac of relevantVacs) {
      const vStart = parseDate(vac.startDate);
      const vEnd   = parseDate(vac.endDate);

      // Does this vacation overlap [warnDate, runOut]?
      if (vStart <= runOut && vEnd >= warnDate) {
        const beforeVac = addDays(vStart, -1);
        if (beforeVac < warnDate) {
          warnDate = beforeVac;
          changed  = true;
        }
      }
    }
  }

  return localDateStr(warnDate);
}

/* ═══════════════════════════════════════════
   Combined status summary
═══════════════════════════════════════════ */

/**
 * Returns a full status snapshot for one medication.
 * Used by both the calendar renderer and the sidebar.
 *
 * Vacations are filtered to only those relevant for this medication:
 *   — vacations with no doctorId apply to all meds
 *   — vacations with a doctorId only apply to meds from that doctor
 *
 * @returns {{ stock, rate, runOut, warn, daysLeft, orderBy }}
 *   orderBy — date by which medication must be ordered (runOut - pharmacyDays)
 */
function medStatus(med, refills, logs, allVacations, doctorLeadDays = 14, pharmacyDays = 7) {
  // Only vacations from the same doctor (or unlinked vacations) affect this med
  const relevantVacs = allVacations.filter((v) =>
    !v.doctorId || !med.doctorId || v.doctorId === med.doctorId
  );

  const stock    = effectiveStock(med, refills, logs);
  const rate     = dailyRate(med);
  const runOut   = predictRunOut(stock, rate);
  const warn     = runOut ? warningStart(runOut, relevantVacs, doctorLeadDays, pharmacyDays) : null;
  const daysLeft = runOut ? daysBetween(todayStr(), runOut) : null;
  // The last safe day to place a pharmacy order
  const orderBy  = runOut ? localDateStr(addDays(parseDate(runOut), -pharmacyDays)) : null;

  return { stock, rate, runOut, warn, daysLeft, orderBy };
}
