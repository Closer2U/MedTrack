/**
 * app.js — MedTracker main application
 * ======================================
 * Vanilla JS, no frameworks. Single-page app with tab-based navigation.
 * All persistent state lives in IndexedDB (db.js).
 * All calculations are pure functions in calc.js.
 *
 * Section map:
 *   CONSTANTS    — colors, labels, month/day names
 *   STATE        — in-memory cache of DB data
 *   HELPERS      — DOM utilities, toast, modal open/close
 *   LOAD         — fetches all stores from DB, pre-computes statuses
 *   CALENDAR     — monthly grid rendering
 *   SIDEBAR      — upcoming run-out list
 *   VIEWS        — render functions for each tab
 *   MODALS       — day detail, medication, doctor, appointment, formulary, refill, vacation
 *   DELETE OPS   — archive/delete helpers
 *   EXPORT/IMPORT— JSON backup and restore
 *   EVENTS       — global DOM wiring
 *   INIT         — service worker + bootstrap
 */

/* ══════════════════════════════════════
   CONSTANTS
══════════════════════════════════════ */

const MED_COLORS = [
  '#3b82f6','#f97316','#22c55e','#a855f7','#ef4444',
  '#f59e0b','#14b8a6','#ec4899','#64748b','#78716c',
];

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const DAY_ABBR = ['Mo','Tu','We','Th','Fr','Sa','Su'];

// Human-readable labels for each intake type
const INTAKE_LABELS = {
  daily   : 'Daily',
  interval: 'Interval (injection/depot)',
  prn     : 'As needed (PRN)',
  // backward compat labels
  fixed   : 'Daily (fixed)',
  variable: 'Daily (variable)',
  as_needed:'As needed (PRN)',
};

const VAC_TYPES = { mine: 'My vacation', doctor: "Doctor's vacation" };

const APPT_TYPES = [
  { value: 'checkup',      label: 'Check-up' },
  { value: 'prescription', label: 'Prescription pick-up' },
  { value: 'followup',     label: 'Follow-up' },
  { value: 'injection',    label: 'Injection / infusion' },
  { value: 'other',        label: 'Other' },
];

/* ══════════════════════════════════════
   STATE — in-memory cache
══════════════════════════════════════ */

const App = {
  state: {
    view        : 'calendar',
    year        : new Date().getFullYear(),
    month       : new Date().getMonth(),
    medications : [],
    formulary   : [],
    vacations   : [],
    doctors     : [],
    appointments: [],
    allLogs     : [],
    allRefills  : [],
    settings    : { doctorLeadDays: 14, pharmacyDays: 7 },
    statuses    : {},  // { [medId]: medStatus result }
  },
};

/* ══════════════════════════════════════
   HELPERS
══════════════════════════════════════ */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function fmtDate(str) {
  if (!str) return '—';
  const [y,m,d] = str.split('-').map(Number);
  return `${MONTH_NAMES[m-1]} ${d}, ${y}`;
}

function nextColor() {
  const used = App.state.medications.map((m) => m.color);
  return MED_COLORS.find((c) => !used.includes(c))
    ?? MED_COLORS[App.state.medications.length % MED_COLORS.length];
}

function toast(msg, type = 'info') {
  const t = el('div', `toast toast--${type}`, esc(msg));
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--visible'));
  setTimeout(() => { t.classList.remove('toast--visible'); setTimeout(() => t.remove(), 300); }, 2800);
}

function openModal(htmlContent) {
  const overlay = document.getElementById('modal-overlay');
  const box     = document.getElementById('modal-box');
  box.innerHTML = htmlContent;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => box.querySelector('input,select,textarea')?.focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-box').innerHTML = '';
  document.body.style.overflow = '';
}

/** Doctor name lookup — returns display string */
function doctorName(doctorId) {
  if (!doctorId) return '';
  const d = App.state.doctors.find((x) => x.id === doctorId);
  return d ? d.name : '—';
}

/** Build <option> list for a doctor selector */
function doctorOptions(selectedId = null, blankLabel = '— None / any doctor —') {
  const opts = [`<option value="">${esc(blankLabel)}</option>`];
  App.state.doctors.forEach((d) => {
    opts.push(`<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.name)}${d.specialty ? ' · ' + esc(d.specialty) : ''}</option>`);
  });
  return opts.join('');
}

/* ══════════════════════════════════════
   LOAD
══════════════════════════════════════ */

async function loadAll() {
  const st = App.state;
  [
    st.medications,
    st.formulary,
    st.vacations,
    st.doctors,
    st.appointments,
    st.allLogs,
    st.allRefills,
  ] = await Promise.all([
    dbGetAll(S.MEDICATIONS),
    dbGetAll(S.FORMULARY),
    dbGetAll(S.VACATIONS),
    dbGetAll(S.DOCTORS),
    dbGetAll(S.APPOINTMENTS),
    dbGetAll(S.DAILY_LOGS),
    dbGetAll(S.REFILL_LOGS),
  ]);

  st.settings.doctorLeadDays = await settingGet('doctorLeadDays', 14);
  st.settings.pharmacyDays   = await settingGet('pharmacyDays', 7);

  // Pre-compute status for every active medication
  st.statuses = {};
  for (const med of st.medications.filter((m) => m.active)) {
    const refills = st.allRefills.filter((r) => r.medicationId === med.id);
    const logs    = st.allLogs.filter((l) => l.medicationId === med.id);
    st.statuses[med.id] = medStatus(
      med, refills, logs, st.vacations,
      st.settings.doctorLeadDays, st.settings.pharmacyDays
    );
  }
}

/* ══════════════════════════════════════
   CALENDAR
══════════════════════════════════════ */

function renderCalendar() {
  const { year, month, medications, vacations, appointments, statuses } = App.state;
  const todayS     = todayStr();
  const activeMeds = medications.filter((m) => m.active);

  document.getElementById('month-label').textContent = `${MONTH_NAMES[month]} ${year}`;

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  // Day-of-week headers (Monday-first grid)
  DAY_ABBR.forEach((d) => grid.appendChild(el('div', 'cal-day-header', d)));

  const firstDate   = new Date(year, month, 1);
  const startOffset = (firstDate.getDay() + 6) % 7; // Mon=0 … Sun=6
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < startOffset; i++) {
    grid.appendChild(el('div', 'cal-cell cal-cell--empty'));
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateS   = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday = dateS === todayS;

    const myVac  = vacations.filter((v) => v.type === 'mine'   && inRange(dateS, v.startDate, v.endDate));
    const drVac  = vacations.filter((v) => v.type === 'doctor' && inRange(dateS, v.startDate, v.endDate));
    const dayAppts = appointments.filter((a) => a.date === dateS);

    let isRunOut = false;
    let isWarn   = false;

    // Dots: only shown up to and including the predicted run-out date
    const dots = [];
    for (const med of activeMeds) {
      const st = statuses[med.id];
      if (!st) continue;

      if (st.runOut === dateS) isRunOut = true;
      if (st.warn && st.runOut && dateS >= st.warn && dateS <= st.runOut) isWarn = true;

      // ← KEY: dot only shown if we haven't yet passed the run-out date
      if (!st.runOut || dateS <= st.runOut) {
        dots.push({ color: med.color, name: med.tradeName, isRunOut: st.runOut === dateS });
      }
    }

    const classes = ['cal-cell'];
    if (isToday)           classes.push('cal-cell--today');
    if (isRunOut)          classes.push('cal-cell--runout');
    else if (isWarn)       classes.push('cal-cell--warn');
    if (myVac.length)      classes.push('cal-cell--myvac');
    else if (drVac.length) classes.push('cal-cell--drvac');

    const cell = el('div', classes.join(' '));
    cell.dataset.date = dateS;

    // Header row: date number + vacation icons + appointment icon
    const header = el('div', 'cal-cell__header');
    header.appendChild(el('span', 'cal-cell__num', String(day)));
    if (myVac.length)    header.appendChild(el('span', 'cal-vac-icon', '🌴'));
    if (drVac.length)    header.appendChild(el('span', 'cal-vac-icon', '🏥'));
    if (dayAppts.length) header.appendChild(el('span', 'cal-vac-icon', '📌'));
    cell.appendChild(header);

    // Medication dots
    if (dots.length > 0) {
      const dotRow  = el('div', 'cal-dots');
      const maxDots = 7;
      dots.slice(0, maxDots).forEach((dot) => {
        const d = el('span', 'cal-dot' + (dot.isRunOut ? ' cal-dot--runout' : ''));
        d.style.background = dot.color;
        d.title = dot.name;
        dotRow.appendChild(d);
      });
      if (dots.length > maxDots) {
        dotRow.appendChild(el('span', 'cal-dot-more', `+${dots.length - maxDots}`));
      }
      cell.appendChild(dotRow);
    }

    cell.addEventListener('click', () => openDayModal(dateS));
    grid.appendChild(cell);
  }
}

/* ══════════════════════════════════════
   SIDEBAR
══════════════════════════════════════ */

function renderSidebar() {
  const { medications, statuses } = App.state;
  const sidebar   = document.getElementById('sidebar-runouts');
  const todayS    = todayStr();
  const activeMeds = medications
    .filter((m) => {
      const st = statuses[m.id];
      // Only show meds with a run-out date that is ≤99 days away
      return m.active && st?.runOut && st.daysLeft != null && st.daysLeft <= 99;
    })
    .sort((a, b) => statuses[a.id].runOut.localeCompare(statuses[b.id].runOut));

   // V6 Single next-appointment indicator for the whole panel
   const apptEl   = document.getElementById('sidebar-next-appt');
   if (apptEl) {
     const nextAppt = App.state.appointments
    .filter((a) => a.date >= todayS)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
     apptEl.textContent = nextAppt
    ? ` ${daysBetween(todayS, nextAppt.date) === 0 ? 'appt. today' : 'next appt.: ' + daysBetween(todayS, nextAppt.date) + 'd left'}`
    : ''; 
    }
    // end V6 
   
  if (activeMeds.length === 0) {
    const hasAny = medications.some((m) => m.active && statuses[m.id]?.runOut);
    sidebar.innerHTML = hasAny
      ? '<p class="sidebar-empty">All medications have &gt;99 days remaining.</p>'
      : '<p class="sidebar-empty">No medications tracked yet.</p>';
    return;
  }

  sidebar.innerHTML = activeMeds.map((med) => {
    const st        = statuses[med.id];
    const days      = st.daysLeft;
    const isUrgent  = st.warn && todayS >= st.warn;
    const cls       = 'sidebar-med' + (isUrgent ? ' sidebar-med--urgent' : '');
    const daysLabel = days != null
      ? (days <= 0 ? '<span class="tag tag--red">TODAY</span>' : `<span class="days-left">${days}d left</span>`)
      : '';
    const drLabel = doctorName(med.doctorId);

    return `
      <div class="${cls}">
        <span class="sidebar-dot" style="background:${esc(med.color)}"></span>
        <div class="sidebar-med__info">
          <div class="sidebar-med__name">${esc(med.tradeName)}</div>
          <div class="sidebar-med__date">${fmtDate(st.runOut)}${drLabel ? ' · ' + esc(drLabel) : ''}</div>
          ${st.orderBy ? `<div class="sidebar-med__order">Order by: <strong>${fmtDate(st.orderBy)}</strong></div>` : ''}
        </div>
        <div class="sidebar-med__right">
          ${daysLabel}
          ${isUrgent ? '<span class="tag tag--orange">⚠ Refill</span>' : ''}
        </div>
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════
   VIEWS
══════════════════════════════════════ */

function setView(name) {
  App.state.view = name;
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('view--active', v.id === `view-${name}`));
  document.querySelectorAll('[data-nav]').forEach((b) =>
    b.classList.toggle('nav__btn--active', b.dataset.nav === name));
  renderView(name);
}

function renderView(name) {
  if      (name === 'calendar')    { renderCalendar(); renderSidebar(); }
  else if (name === 'medications') { renderMedicationsView(); }
  else if (name === 'formulary')   { renderFormularyView(); }
  else if (name === 'refills')     { renderRefillsView(); }
  else if (name === 'doctors')     { renderDoctorsView(); }
  else if (name === 'settings')    { renderSettingsView(); }
}

/* ──── Medications view ──── */
function renderMedicationsView() {
  const { medications, statuses } = App.state;
  const container = document.getElementById('view-medications');
  const active    = medications.filter((m) => m.active);
  const archived  = medications.filter((m) => !m.active);

  container.innerHTML = `
    <div class="view-header">
      <h2>Medications</h2>
      <button class="btn btn--primary" id="btn-add-med">+ Add medication</button>
    </div>
    <div class="med-list">
      ${active.length === 0 ? '<p class="empty-hint">No medications yet. Add your first one!</p>' : active.map(medCard).join('')}
    </div>
    ${archived.length > 0 ? `
      <h3 class="section-title section-title--muted" style="margin-top:2rem">Archived</h3>
      <div class="med-list med-list--archived">${archived.map(medCard).join('')}</div>
    ` : ''}`;

  container.querySelector('#btn-add-med').addEventListener('click', () => openMedModal());
  container.querySelectorAll('[data-edit-med]').forEach((b) =>
    b.addEventListener('click', () => openMedModal(Number(b.dataset.editMed))));
  container.querySelectorAll('[data-stock-med]').forEach((b) =>
    b.addEventListener('click', () => openStockModal(Number(b.dataset.stockMed))));
  container.querySelectorAll('[data-archive-med]').forEach((b) =>
    b.addEventListener('click', () => toggleArchiveMed(Number(b.dataset.archiveMed))));
  container.querySelectorAll('[data-delete-med]').forEach((b) =>
    b.addEventListener('click', () => deleteMedication(Number(b.dataset.deleteMed))));
}

function medCard(med) {
  const st         = App.state.statuses[med.id];
  const stock      = st ? Math.round(st.stock * 10) / 10 : '—';
  const runoutLabel= st?.runOut ? fmtDate(st.runOut) : (med.intakeType === 'prn' ? 'PRN — estimate if needed' : '—');
  const urgent     = st?.warn && todayStr() >= st.warn;
  const drLabel    = doctorName(med.doctorId);
  const typeLabel  = INTAKE_LABELS[med.intakeType] ?? med.intakeType;

  // Describe the dose schedule in a compact string
  let doseDesc = '';
  if (med.intakeType === 'interval') {
    doseDesc = `${med.dosePerInterval ?? 1} ${med.unit ?? 'unit'} every ${med.intervalDays ?? 28} days`;
  } else if (med.intakeType === 'daily' || med.intakeType === 'fixed') {
    doseDesc = med.variableDose
      ? `~${med.weeklyMedianDose ?? '?'} ${med.unit ?? 'units'}/week (variable)`
      : `${med.fixedDailyDose ?? 1} ${med.unit ?? 'unit'}/day`;
  } else if (med.intakeType === 'prn' || med.intakeType === 'as_needed' || med.intakeType === 'variable') {
    doseDesc = `~${med.weeklyMedianDose ?? '?'} ${med.unit ?? 'units'}/week`;
  }

  return `
    <div class="med-card ${urgent ? 'med-card--urgent' : ''}" data-id="${med.id}">
      <div class="med-card__color" style="background:${esc(med.color)}"></div>
      <div class="med-card__body">
        <div class="med-card__title">
          ${esc(med.tradeName)}
          ${med.strength ? `<span class="tag">${esc(med.strength)}</span>` : ''}
          <span class="tag tag--muted">${esc(typeLabel)}</span>
        </div>
        <div class="med-card__sub">
          ${esc(med.genericName || '')}${drLabel ? ` · <em>${esc(drLabel)}</em>` : ''}
        </div>
        <div class="med-card__dose-desc">${esc(doseDesc)}</div>
        <div class="med-card__stats">
          <span>📦 Stock: <strong>${stock} ${esc(med.unit ?? 'units')}</strong></span>
          <span>📅 Runs out: <strong class="${urgent ? 'text-warn' : ''}">${runoutLabel}</strong></span>
          ${st?.orderBy ? `<span>🛒 Order by: <strong>${fmtDate(st.orderBy)}</strong></span>` : ''}
        </div>
      </div>
      <div class="med-card__actions">
        <button class="btn btn--sm btn--primary" data-stock-med="${med.id}">Update stock</button>
        <button class="btn btn--sm btn--ghost" data-edit-med="${med.id}">Edit</button>
        <button class="btn btn--sm btn--ghost btn--muted" data-archive-med="${med.id}">${med.active ? 'Archive' : 'Restore'}</button>
        <button class="btn btn--sm btn--ghost btn--danger" data-delete-med="${med.id}">Delete</button>
      </div>
    </div>`;
}

/* ──── Formulary view ──── */
function renderFormularyView() {
  const { formulary } = App.state;
  const container = document.getElementById('view-formulary');

  container.innerHTML = `
    <div class="view-header">
      <h2>Medication Database</h2>
      <button class="btn btn--primary" id="btn-add-form">+ Add entry</button>
    </div>
    <p class="view-desc">Reusable templates for quickly adding tracked medications. N1/N2/N3 are German standard pack sizes.</p>
    <div class="form-list">
      ${formulary.length === 0 ? '<p class="empty-hint">No entries yet.</p>' : formulary.map(formularyRow).join('')}
    </div>`;

  container.querySelector('#btn-add-form').addEventListener('click', () => openFormularyModal());
  container.querySelectorAll('[data-edit-form]').forEach((b) =>
    b.addEventListener('click', () => openFormularyModal(Number(b.dataset.editForm))));
  container.querySelectorAll('[data-del-form]').forEach((b) =>
    b.addEventListener('click', () => deleteFormularyEntry(Number(b.dataset.delForm))));
}

function formularyRow(f) {
  return `
    <div class="form-row">
      <div class="form-row__main">
        <div class="form-row__title">${esc(f.tradeName)}</div>
        <div class="form-row__sub">${esc(f.genericName)}${f.strength ? ' · ' + esc(f.strength) : ''}${f.form ? ' · ' + esc(f.form) : ''}</div>
        ${f.manufacturer ? `<div class="form-row__mfr">Hersteller: ${esc(f.manufacturer)}</div>` : ''}
        ${(f.n1||f.n2||f.n3) ? `<div class="form-row__packs">
          ${f.n1 ? `<span class="tag">N1: ${esc(String(f.n1))}</span>` : ''}
          ${f.n2 ? `<span class="tag">N2: ${esc(String(f.n2))}</span>` : ''}
          ${f.n3 ? `<span class="tag">N3: ${esc(String(f.n3))}</span>` : ''}
        </div>` : ''}
        ${f.sideEffects ? `<div class="form-row__se">⚠ ${esc(f.sideEffects)}</div>` : ''}
      </div>
      <div class="form-row__actions">
        <button class="btn btn--sm btn--ghost" data-edit-form="${f.id}">Edit</button>
        <button class="btn btn--sm btn--ghost btn--danger" data-del-form="${f.id}">Delete</button>
      </div>
    </div>`;
}

/* ──── Refills view ──── */
function renderRefillsView() {
  const { medications, allRefills } = App.state;
  const container = document.getElementById('view-refills');
  const medMap    = Object.fromEntries(medications.map((m) => [m.id, m]));
  const sorted    = [...allRefills].sort((a,b) => b.date.localeCompare(a.date));

  container.innerHTML = `
    <div class="view-header">
      <h2>Refill History</h2>
      <button class="btn btn--primary" id="btn-add-refill">+ Log refill</button>
    </div>
    <div class="refill-list">
      ${sorted.length === 0 ? '<p class="empty-hint">No refills logged yet.</p>'
        : sorted.map((r) => refillRow(r, medMap[r.medicationId])).join('')}
    </div>`;

  container.querySelector('#btn-add-refill').addEventListener('click', () => openRefillModal());
  container.querySelectorAll('[data-del-refill]').forEach((b) =>
    b.addEventListener('click', () => deleteRefill(Number(b.dataset.delRefill))));
}

function refillRow(r, med) {
  return `
    <div class="refill-row">
      <span class="sidebar-dot" style="background:${esc(med?.color ?? '#ccc')}"></span>
      <div class="refill-row__info">
        <div class="refill-row__name">${esc(med?.tradeName ?? 'Unknown')}</div>
        <div class="refill-row__detail">
          ${fmtDate(r.date)} · <strong>${esc(String(r.amount))} ${esc(med?.unit ?? 'units')}</strong>
          ${r.packSize ? `· Pack ${esc(r.packSize)}` : ''}
          ${r.manufacturer ? `· ${esc(r.manufacturer)}` : ''}
        </div>
        ${r.notes ? `<div class="refill-row__notes">${esc(r.notes)}</div>` : ''}
      </div>
      <button class="btn btn--sm btn--ghost btn--danger" data-del-refill="${r.id}">×</button>
    </div>`;
}

/* ──── Doctors view ──── */
function renderDoctorsView() {
  const { doctors, appointments, medications } = App.state;
  const container = document.getElementById('view-doctors');

  // Count meds and upcoming appointments per doctor
  const apptMap = {};
  const medMap2 = {};
  appointments.forEach((a) => { apptMap[a.doctorId] = (apptMap[a.doctorId] || 0) + 1; });
  medications.filter((m)=>m.active).forEach((m) => { if (m.doctorId) medMap2[m.doctorId] = (medMap2[m.doctorId]||0)+1; });

  container.innerHTML = `
    <div class="view-header">
      <h2>Doctors</h2>
      <div style="display:flex;gap:.5rem">
        <button class="btn btn--ghost" id="btn-add-appt">+ Add appointment</button>
        <button class="btn btn--primary" id="btn-add-doc">+ Add doctor</button>
      </div>
    </div>
    <div class="doctor-list">
      ${doctors.length === 0
        ? '<p class="empty-hint">No doctors added yet.</p>'
        : doctors.map((d) => doctorCard(d, medMap2[d.id]||0, apptMap[d.id]||0)).join('')}
    </div>

    <h3 class="section-title" style="margin-top:2rem">All Appointments</h3>
    ${renderAppointmentList(appointments, doctors)}

    <h3 class="section-title" style="margin-top:2rem">Vacation &amp; Absence Periods</h3>
    <p class="view-desc" style="margin-bottom:.75rem">Link each period to a doctor so that only meds from that doctor are affected. An unlinked period affects all medications.</p>
    <button class="btn btn--primary btn--sm" id="btn-add-vac" style="margin-bottom:.75rem">+ Add period</button>
    <div class="vac-list" id="vac-list-container">
      ${App.state.vacations.length === 0
        ? '<p class="empty-hint">No vacation periods set.</p>'
        : [...App.state.vacations].sort((a,b)=>a.startDate.localeCompare(b.startDate)).map(vacRow).join('')}
    </div>`;

  container.querySelector('#btn-add-doc').addEventListener('click', () => openDoctorModal());
  container.querySelector('#btn-add-appt').addEventListener('click', () => openAppointmentModal());
  container.querySelectorAll('[data-edit-doc]').forEach((b) =>
    b.addEventListener('click', () => openDoctorModal(Number(b.dataset.editDoc))));
  container.querySelectorAll('[data-del-doc]').forEach((b) =>
    b.addEventListener('click', () => deleteDoctor(Number(b.dataset.delDoc))));
  container.querySelectorAll('[data-edit-appt]').forEach((b) =>
    b.addEventListener('click', () => openAppointmentModal(Number(b.dataset.editAppt))));
  container.querySelectorAll('[data-del-appt]').forEach((b) =>
    b.addEventListener('click', () => deleteAppointment(Number(b.dataset.delAppt))));
  // Vacation wiring
  container.querySelector('#btn-add-vac').addEventListener('click', () => openVacationModal());
  container.querySelectorAll('[data-edit-vac]').forEach((b) =>
    b.addEventListener('click', () => openVacationModal(Number(b.dataset.editVac))));
  container.querySelectorAll('[data-del-vac]').forEach((b) =>
    b.addEventListener('click', () => deleteVacation(Number(b.dataset.delVac))));
}

function doctorCard(d, medCount, apptCount) {
  return `
    <div class="doctor-card">
      <div class="doctor-card__avatar">${esc(d.name.charAt(0).toUpperCase())}</div>
      <div class="doctor-card__body">
        <div class="doctor-card__name">${esc(d.name)}</div>
        ${d.specialty ? `<div class="doctor-card__spec">${esc(d.specialty)}</div>` : ''}
        ${d.phone    ? `<div class="doctor-card__meta">📞 ${esc(d.phone)}</div>` : ''}
        ${d.address  ? `<div class="doctor-card__meta">📍 ${esc(d.address)}</div>` : ''}
        <div class="doctor-card__counts">
          <span class="tag">${medCount} active med${medCount!==1?'s':''}</span>
          <span class="tag">${apptCount} appointment${apptCount!==1?'s':''}</span>
        </div>
      </div>
      <div class="doctor-card__actions">
        <button class="btn btn--sm btn--ghost" data-edit-doc="${d.id}">Edit</button>
        <button class="btn btn--sm btn--ghost btn--danger" data-del-doc="${d.id}">Delete</button>
      </div>
    </div>`;
}

function renderAppointmentList(appointments, doctors) {
  const todayS  = todayStr();
  const doctorMap = Object.fromEntries(doctors.map((d) => [d.id, d]));
  const sorted  = [...appointments].sort((a,b) => a.date.localeCompare(b.date));
  const upcoming = sorted.filter((a) => a.date >= todayS);
  const past     = sorted.filter((a) => a.date  < todayS);

  const renderApptRow = (a) => {
    const doc      = doctorMap[a.doctorId];
    const typeLabel= APPT_TYPES.find((t) => t.value === a.type)?.label ?? a.type ?? '';
    const isPast   = a.date < todayS;
    return `
      <div class="appt-row ${isPast ? 'appt-row--past' : ''}">
        <div class="appt-row__date">
          <div class="appt-row__day">${String(new Date(a.date+'T00:00').getDate()).padStart(2,'0')}</div>
          <div class="appt-row__mon">${MONTH_NAMES[new Date(a.date+'T00:00').getMonth()].slice(0,3)}</div>
        </div>
        <div class="appt-row__info">
          <div class="appt-row__title">${esc(typeLabel)}${a.time ? ' · ' + esc(a.time) : ''}</div>
          <div class="appt-row__doc">${doc ? esc(doc.name) + (doc.specialty ? ' · ' + esc(doc.specialty) : '') : '—'}</div>
          ${a.notes ? `<div class="appt-row__notes">${esc(a.notes)}</div>` : ''}
        </div>
        <div class="appt-row__actions">
          <button class="btn btn--sm btn--ghost" data-edit-appt="${a.id}">Edit</button>
          <button class="btn btn--sm btn--ghost btn--danger" data-del-appt="${a.id}">×</button>
        </div>
      </div>`;
  };

  return `
    ${upcoming.length > 0 ? `<div class="appt-group"><h4 class="appt-group__title">Upcoming</h4>${upcoming.map(renderApptRow).join('')}</div>` : '<p class="empty-hint">No upcoming appointments.</p>'}
    ${past.length > 0 ? `<details class="appt-past-details"><summary>Past appointments (${past.length})</summary><div class="appt-group">${[...past].reverse().map(renderApptRow).join('')}</div></details>` : ''}`;
}

/* ──── Settings view ──── */
function renderSettingsView() {
  const { settings } = App.state;
  const total = settings.doctorLeadDays + settings.pharmacyDays;
  const container = document.getElementById('view-settings');

  container.innerHTML = `
    <div class="view-header"><h2>Settings</h2></div>

    <section class="settings-section">
      <h3>Refill Warning Window</h3>
      <p class="view-desc">
        The warning window = <strong>doctor lead time + pharmacy delivery time</strong>.
        Currently: ${settings.doctorLeadDays} + ${settings.pharmacyDays} = <strong>${total} days</strong> before predicted run-out.
        The window is automatically pushed earlier if a relevant vacation falls within it.
      </p>
      <div class="setting-row">
        <label class="field-label">Doctor lead time (days)
          <input type="number" id="input-lead-days" class="input input--sm" min="1" max="60" value="${settings.doctorLeadDays}">
        </label>
        <label class="field-label">Pharmacy delivery (days)
          <input type="number" id="input-pharmacy-days" class="input input--sm" min="0" max="30" value="${settings.pharmacyDays}">
        </label>
        <button class="btn btn--primary btn--sm" id="btn-save-lead" style="align-self:flex-end">Save</button>
      </div>
    </section>

    <section class="settings-section">
      <h3>Backup &amp; Restore</h3>
      <p class="view-desc">All data lives in your browser's IndexedDB. Export before clearing browser data or switching devices. Import merges — it never deletes existing records.</p>
      <div class="setting-row" style="flex-wrap:wrap">
        <button class="btn btn--primary btn--sm" id="btn-export">⬇ Export backup (.json)</button>
        <label class="btn btn--ghost btn--sm" style="cursor:pointer">
          ⬆ Import backup
          <input type="file" id="input-import" accept=".json" style="display:none">
        </label>
      </div>
    </section>

    <section class="settings-section">
      <h3>About</h3>
      <p class="view-desc">MedTracker · Offline-first PWA · All data stored locally via IndexedDB · No data ever leaves your device.</p>
    </section>`;

  container.querySelector('#btn-save-lead').addEventListener('click', async () => {
    const lead    = parseInt(document.getElementById('input-lead-days').value, 10);
    const pharmacy= parseInt(document.getElementById('input-pharmacy-days').value, 10);
    if (!lead || lead < 1) { toast('Enter a valid doctor lead time', 'error'); return; }
    if (isNaN(pharmacy) || pharmacy < 0) { toast('Enter a valid pharmacy delivery time', 'error'); return; }
    await settingSet('doctorLeadDays', lead);
    await settingSet('pharmacyDays',   pharmacy);
    App.state.settings.doctorLeadDays = lead;
    App.state.settings.pharmacyDays   = pharmacy;
    await loadAll();
    renderView(App.state.view);
    toast(`Warning window: ${lead} + ${pharmacy} = ${lead+pharmacy} days`);
  });

  container.querySelector('#btn-export').addEventListener('click', exportData);
  const importInput = container.querySelector('#input-import');
  importInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importData(file);
    importInput.value = '';
  });
}

function vacRow(v) {
  const typeIcon = v.type === 'mine' ? '🌴' : '🏥';
  const drLabel  = doctorName(v.doctorId);
  return `
    <div class="vac-row">
      <span class="vac-row__icon">${typeIcon}</span>
      <div class="vac-row__info">
        <div class="vac-row__label">${esc(VAC_TYPES[v.type] ?? v.type)}${v.label ? ': ' + esc(v.label) : ''}${drLabel ? ` <span class="tag tag--muted">${esc(drLabel)}</span>` : ''}</div>
        <div class="vac-row__dates">${fmtDate(v.startDate)} → ${fmtDate(v.endDate)}</div>
      </div>
      <div class="vac-row__actions">
        <button class="btn btn--sm btn--ghost" data-edit-vac="${v.id}">Edit</button>
        <button class="btn btn--sm btn--ghost btn--danger" data-del-vac="${v.id}">Delete</button>
      </div>
    </div>`;
}

/* ══════════════════════════════════════
   AUTO-RATE CALCULATION
══════════════════════════════════════ */

/**
 * Calculates a suggested weekly median dose from the last 28 days of logs
 * for a given medication, rounded to the nearest 0.5.
 *
 * Only days where taken=true are included in the average — skipped days
 * are excluded so PRN and variable meds aren't dragged down by zero-days.
 * Requires at least 7 logged (taken) days to return a result.
 *
 * @param {number} medId
 * @returns {number|null} weekly dose rounded to 0.5, or null if insufficient data
 */
async function calcAutoRate(medId) {
  const allLogs = await loadLogsForMed(medId);

  // Look back 28 days for a reasonable sample
  const cutoff  = localDateStr(addDays(new Date(), -28));
  const recent  = allLogs.filter((l) => l.date >= cutoff && l.taken && (Number(l.dose) || 0) > 0);

  if (recent.length < 7) return null;

  const totalDose = recent.reduce((sum, l) => sum + (Number(l.dose) || 0), 0);
  const days      = recent.length;

  // Scale to a week, then round to nearest 0.5
  const weeklyRaw    = (totalDose / days) * 7;
  const weeklyRounded = Math.round(weeklyRaw * 2) / 2;

  return weeklyRounded;
}

/* ══════════════════════════════════════
   MODALS
══════════════════════════════════════ */

/* ──── Day modal ──── */
async function openDayModal(dateS) {
  const { medications, vacations, appointments, doctors, allLogs } = App.state;
  const activeMeds = medications.filter((m) => m.active);
  const todayS     = todayStr();
  const isPast     = dateS <= todayS;

  // Cached logs for this specific date
  const dayLogs = {};
  allLogs.filter((l) => l.date === dateS).forEach((l) => { dayLogs[l.medicationId] = l; });

  const myVac    = vacations.filter((v) => v.type === 'mine'   && inRange(dateS, v.startDate, v.endDate));
  const drVac    = vacations.filter((v) => v.type === 'doctor' && inRange(dateS, v.startDate, v.endDate));
  const dayAppts = appointments.filter((a) => a.date === dateS);
  const docMap   = Object.fromEntries(doctors.map((d) => [d.id, d]));

  // Build med rows for logging
  const medRows = activeMeds.map((med) => {
    const log   = dayLogs[med.id];
    // Default "taken" state: true for daily fixed meds (they take it every day)
    const taken = log ? log.taken : (med.intakeType === 'daily' && !med.variableDose);
    const dose  = log
      ? log.dose
      : (med.intakeType === 'daily' && !med.variableDose ? med.fixedDailyDose : 0);
    const notes = log?.notes ?? '';

    // Dose step: 0.5 allows half-tablet entries
    return `
      <div class="day-med-row" data-med-id="${med.id}">
        <div class="day-med-row__header">
          <span class="sidebar-dot" style="background:${esc(med.color)}"></span>
          <span class="day-med-row__name">${esc(med.tradeName)}</span>
          ${med.strength ? `<span class="tag">${esc(med.strength)}</span>` : ''}
          <label class="toggle">
            <input type="checkbox" class="log-taken" data-med="${med.id}" ${taken ? 'checked' : ''}>
            <span class="toggle__label">Taken</span>
          </label>
        </div>
        <div class="day-med-row__fields ${!taken ? 'hidden' : ''}" id="fields-${med.id}">
          <label class="field-label">
            Dose (${esc(med.unit ?? 'units')})
            <input type="number" class="input log-dose" data-med="${med.id}"
              step="0.5" min="0" value="${esc(String(dose))}">
          </label>
          <label class="field-label">
            Notes
            <input type="text" class="input log-notes" data-med="${med.id}"
              value="${esc(notes)}" placeholder="Optional note…">
          </label>
        </div>
      </div>`;
  }).join('') || '<p class="empty-hint">No medications tracked. Add some in the Medications tab.</p>';

  // Run-out info for future dates
  const futureRunoutInfo = activeMeds.map((med) => {
    const st = App.state.statuses[med.id];
    const isRunOut = st?.runOut === dateS;
    const isWarn   = st?.warn && dateS >= st.warn && st.runOut && dateS <= st.runOut;
    if (!isRunOut && !isWarn) return '';
    return `<div class="day-med-alert ${isRunOut ? 'day-med-alert--runout' : 'day-med-alert--warn'}">
      <span class="sidebar-dot" style="background:${esc(med.color)}"></span>
      ${esc(med.tradeName)}: ${isRunOut ? '⛔ Estimated run-out' : '⚠ In refill window'}
    </div>`;
  }).join('');

  openModal(`
    <div class="modal-header">
      <h2>${esc(fmtDate(dateS))}</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>

    ${myVac.length ? `<div class="vac-badge vac-badge--mine">🌴 Your vacation${myVac[0].label ? ': ' + esc(myVac[0].label) : ''}</div>` : ''}
    ${drVac.length ? `<div class="vac-badge vac-badge--dr">🏥 Doctor vacation: ${esc(drVac[0].label || '')}${drVac[0].doctorId ? ' — ' + esc(doctorName(drVac[0].doctorId)) : ''}</div>` : ''}

    ${dayAppts.length ? `
    <section class="modal-section">
      <h3>📌 Appointments</h3>
      ${dayAppts.map((a) => {
        const doc = docMap[a.doctorId];
        const typeLabel = APPT_TYPES.find((t) => t.value === a.type)?.label ?? '';
        return `<div class="day-appt-row">
          <strong>${esc(typeLabel)}</strong>${a.time ? ' at ' + esc(a.time) : ''}
          ${doc ? ` · ${esc(doc.name)}` : ''}
          ${a.notes ? `<br><span style="color:var(--text-muted);font-size:.82rem">${esc(a.notes)}</span>` : ''}
        </div>`;
      }).join('')}
    </section>` : ''}

    ${futureRunoutInfo ? `<section class="modal-section">${futureRunoutInfo}</section>` : ''}

    ${isPast && activeMeds.length > 0 ? `
    <section class="modal-section">
      <h3>Intake Log</h3>
      <div class="day-med-list">${medRows}</div>
    </section>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-day">Save log</button>
    </div>` : `
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Close</button>
      <button class="btn btn--ghost" id="btn-add-appt-day">+ Add appointment</button>
    </div>`}
  `);

  // Toggle dose fields when "Taken" checkbox changes
  document.querySelectorAll('.log-taken').forEach((cb) => {
    cb.addEventListener('change', () => {
      document.getElementById(`fields-${cb.dataset.med}`)?.classList.toggle('hidden', !cb.checked);
    });
  });

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2')?.addEventListener('click', closeModal);
  document.getElementById('btn-add-appt-day')?.addEventListener('click', () => {
    closeModal();
    openAppointmentModal(null, dateS);
  });

  document.getElementById('btn-save-day')?.addEventListener('click', async () => {
    for (const med of activeMeds) {
      const takenEl = document.querySelector(`.log-taken[data-med="${med.id}"]`);
      const doseEl  = document.querySelector(`.log-dose[data-med="${med.id}"]`);
      const notesEl = document.querySelector(`.log-notes[data-med="${med.id}"]`);
      if (!takenEl) continue;

      const taken = takenEl.checked;
      const dose  = parseFloat(doseEl?.value ?? 0) || 0;

      const existing = await dbGetLog(med.id, dateS);
      await dbPut(S.DAILY_LOGS, {
        ...(existing ? { id: existing.id } : {}),
        medicationId: med.id,
        date : dateS,
        taken,
        dose : taken ? dose : 0,
        notes: notesEl?.value ?? '',
      });
    }
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast('Log saved');
  });
}

/* ──── Add / Edit medication ──── */
async function openMedModal(medId = null) {
  const { formulary } = App.state;
  const med = medId ? await dbGet(S.MEDICATIONS, medId) : null;

  // Normalise legacy intake types to new ones for the form
  let intakeType  = med?.intakeType ?? 'daily';
  let variableDose= med?.variableDose ?? false;
  if (intakeType === 'fixed')    { intakeType = 'daily'; variableDose = false; }
  if (intakeType === 'variable') { intakeType = 'daily'; variableDose = true;  }
  if (intakeType === 'as_needed'){ intakeType = 'prn';   }

  const formularyOpts = formulary.map((f) =>
    `<option value="${f.id}" ${med?.formularyId===f.id?'selected':''}>${esc(f.tradeName)} (${esc(f.genericName)})</option>`
  ).join('');

  openModal(`
    <div class="modal-header">
      <h2>${medId ? 'Edit' : 'Add'} Medication</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">

      ${formulary.length > 0 ? `
      <label class="field-label">Fill from database (optional)
        <select class="input" id="sel-formulary">
          <option value="">— Select template —</option>${formularyOpts}
        </select>
      </label>` : ''}

      <div class="field-row">
        <label class="field-label">Trade name *
          <input class="input" id="med-trade" value="${esc(med?.tradeName??'')}" placeholder="e.g. Metoprolol Ratiopharm">
        </label>
        <label class="field-label">Generic name
          <input class="input" id="med-generic" value="${esc(med?.genericName??'')}">
        </label>
      </div>
      <div class="field-row">
        <label class="field-label">Strength <input class="input" id="med-strength" value="${esc(med?.strength??'')}" placeholder="50 mg"></label>
        <label class="field-label">Form     <input class="input" id="med-form"     value="${esc(med?.form??'')}"     placeholder="Tabletten"></label>
        <label class="field-label">Unit     <input class="input" id="med-unit"     value="${esc(med?.unit??'Tablet')}" placeholder="Tablet / ml"></label>
      </div>

      <label class="field-label">Prescribing doctor
        <select class="input" id="med-doctor">${doctorOptions(med?.doctorId ?? null)}</select>
      </label>

      <label class="field-label">Intake type *
        <select class="input" id="med-intake">
          <option value="daily"    ${intakeType==='daily'    ?'selected':''}>Daily</option>
          <option value="interval" ${intakeType==='interval' ?'selected':''}>Interval — injection / depot (every N days)</option>
          <option value="prn"      ${intakeType==='prn'      ?'selected':''}>As needed (PRN)</option>
        </select>
      </label>

      <!-- Daily fields -->
      <div id="daily-fields" class="${intakeType!=='daily'?'hidden':''}">
        <label class="input-check">
          <input type="checkbox" id="med-variable" ${variableDose?'checked':''}>
          Variable dose (dose changes day to day)
        </label>
        <div id="fixed-dose-field" class="${variableDose?'hidden':''}">
          <label class="field-label" style="margin-top:.5rem">Dose per day *
            <input type="number" class="input" id="med-fixed-dose" step="0.5" min="0.5"
              value="${esc(String(med?.fixedDailyDose??1))}">
          </label>
        </div>
        <div id="variable-dose-field" class="${!variableDose?'hidden':''}">
          <label class="field-label" style="margin-top:.5rem">Typical weekly dose (median) *
            <input type="number" class="input" id="med-weekly" step="0.5" min="0"
              value="${esc(String(med?.weeklyMedianDose??7))}">
          </label>
          <div style="display:flex;align-items:center;gap:.5rem;margin-top:.25rem">
            <p class="field-hint" style="margin:0">A 10% conservative buffer is applied automatically.</p>
            <button type="button" class="btn btn--ghost btn--sm" id="btn-auto-rate">📊 Calculate from logs</button>
          </div>
        </div>
      </div>

      <!-- Interval fields -->
      <div id="interval-fields" class="${intakeType!=='interval'?'hidden':''}">
        <div class="field-row">
          <label class="field-label">Dose per injection *
            <input type="number" class="input" id="med-interval-dose" step="0.5" min="0.5"
              value="${esc(String(med?.dosePerInterval??1))}">
          </label>
          <label class="field-label">Every N days *
            <input type="number" class="input" id="med-interval-days" step="1" min="1"
              value="${esc(String(med?.intervalDays??28))}" placeholder="e.g. 28">
          </label>
        </div>
      </div>

      <!-- PRN fields -->
      <div id="prn-fields" class="${intakeType!=='prn'?'hidden':''}">
        <label class="field-label">Typical weekly dose (median)
          <input type="number" class="input" id="med-prn-weekly" step="0.5" min="0"
            value="${esc(String(med?.weeklyMedianDose??0))}">
        </label>
        <div style="display:flex;align-items:center;gap:.5rem;margin-top:.25rem">
          <p class="field-hint" style="margin:0">Leave 0 if too unpredictable — run-out estimate will be skipped.</p>
          <button type="button" class="btn btn--ghost btn--sm" id="btn-auto-rate">📊 Calculate from logs</button>
        </div>
      </div>

      <hr class="divider">

      <div class="field-row">
        <label class="field-label">Current stock (${med?.unit ?? 'units'}) *
          <input type="number" class="input" id="med-stock" step="0.5" min="0"
            value="${esc(String(med?.stock??0))}">
        </label>
        <label class="field-label">Stock count date *
          <input type="date" class="input" id="med-stock-date" value="${esc(med?.stockDate??todayStr())}">
        </label>
      </div>
      <label class="field-label">Notes
        <textarea class="input" id="med-notes" rows="2">${esc(med?.notes??'')}</textarea>
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-med">Save medication</button>
    </div>
  `);

  // Toggle intake type fields
  const intakeSel = document.getElementById('med-intake');
  const varCb     = document.getElementById('med-variable');

  const toggleIntake = () => {
    const v = intakeSel.value;
    document.getElementById('daily-fields').classList.toggle('hidden', v !== 'daily');
    document.getElementById('interval-fields').classList.toggle('hidden', v !== 'interval');
    document.getElementById('prn-fields').classList.toggle('hidden', v !== 'prn');
  };
  const toggleVar = () => {
    document.getElementById('fixed-dose-field').classList.toggle('hidden', varCb.checked);
    document.getElementById('variable-dose-field').classList.toggle('hidden', !varCb.checked);
  };
  intakeSel.addEventListener('change', toggleIntake);
  varCb.addEventListener('change', toggleVar);

  // Auto-rate button — calculates weekly median from this med's log history.
  // The button may be in either the variable-daily or prn panel; we use event
  // delegation on the modal body so it works regardless of which is visible.
  document.getElementById('modal-box').addEventListener('click', async (e) => {
    if (!e.target.matches('#btn-auto-rate')) return;
    if (!medId) { toast('Save this medication first, then calculate from logs', 'error'); return; }
    const result = await calcAutoRate(medId);
    if (result === null) { toast('Not enough log entries yet (need at least 7 days)', 'error'); return; }
    // Write into whichever field is currently visible
    const weeklyEl = document.getElementById('med-weekly');
    const prnEl    = document.getElementById('med-prn-weekly');
    if (weeklyEl) weeklyEl.value = result;
    if (prnEl)    prnEl.value    = result;
    toast(`Auto-rate set to ${result} ${med?.unit ?? 'units'}/week (from last 28 days of logs)`);
  });

  // Fill from formulary template
  const formSel = document.getElementById('sel-formulary');
  if (formSel) {
    formSel.addEventListener('change', () => {
      const f = formulary.find((x) => x.id === Number(formSel.value));
      if (!f) return;
      document.getElementById('med-trade').value   = f.tradeName   ?? '';
      document.getElementById('med-generic').value = f.genericName ?? '';
      document.getElementById('med-strength').value= f.strength    ?? '';
      document.getElementById('med-form').value    = f.form        ?? '';
    });
  }

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);

  document.getElementById('btn-save-med').addEventListener('click', async () => {
    const trade   = document.getElementById('med-trade').value.trim();
    const stock   = parseFloat(document.getElementById('med-stock').value);
    const sDate   = document.getElementById('med-stock-date').value;
    const intake  = document.getElementById('med-intake').value;
    if (!trade)        { toast('Trade name is required', 'error'); return; }
    if (isNaN(stock))  { toast('Current stock is required', 'error'); return; }
    if (!sDate)        { toast('Stock date is required', 'error'); return; }

    const isVar      = document.getElementById('med-variable')?.checked;
    const fixedDose  = parseFloat(document.getElementById('med-fixed-dose')?.value)      || 1;
    const weeklyDose = parseFloat(document.getElementById('med-weekly')?.value)           || 7;
    const prnWeekly  = parseFloat(document.getElementById('med-prn-weekly')?.value)       || 0;
    const intDose    = parseFloat(document.getElementById('med-interval-dose')?.value)    || 1;
    const intDays    = parseInt(document.getElementById('med-interval-days')?.value, 10)  || 28;

    const record = {
      ...(med ?? {}),
      tradeName        : trade,
      genericName      : document.getElementById('med-generic').value.trim(),
      strength         : document.getElementById('med-strength').value.trim(),
      form             : document.getElementById('med-form').value.trim(),
      unit             : document.getElementById('med-unit').value.trim() || 'Tablet',
      doctorId         : Number(document.getElementById('med-doctor').value) || null,
      intakeType       : intake,
      variableDose     : intake === 'daily' ? isVar : false,
      fixedDailyDose   : fixedDose,
      weeklyMedianDose : intake === 'prn' ? prnWeekly : weeklyDose,
      dosePerInterval  : intDose,
      intervalDays     : intDays,
      stock,
      stockDate        : sDate,
      notes            : document.getElementById('med-notes').value.trim(),
      formularyId      : Number(document.getElementById('sel-formulary')?.value) || (med?.formularyId ?? null),
      color            : med?.color ?? nextColor(),
      active           : med?.active ?? true,
      createdAt        : med?.createdAt ?? todayStr(),
    };

    await dbPut(S.MEDICATIONS, record);
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast(medId ? 'Medication updated' : 'Medication added');
  });
}

/* ──── Update stock (quick modal) ──── */
async function openStockModal(medId) {
  const med = await dbGet(S.MEDICATIONS, medId);
  if (!med) return;
  const st = App.state.statuses[med.id];

  openModal(`
    <div class="modal-header">
      <h2>Update Stock — ${esc(med.tradeName)}</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      ${st ? `<div class="stock-info-box">
        <div>Calculated current stock: <strong>${Math.round(st.stock * 10) / 10} ${esc(med.unit ?? 'units')}</strong></div>
        <div class="field-hint">Based on your baseline of ${med.stock} on ${fmtDate(med.stockDate)}, minus estimated consumption since then.</div>
      </div>` : ''}
      <p class="view-desc">Count your actual pills and enter the real number. This resets the baseline for future calculations.</p>
      <div class="field-row">
        <label class="field-label">Actual stock (${esc(med.unit ?? 'units')}) *
          <input type="number" class="input" id="stock-val" step="0.5" min="0"
            value="${esc(String(st ? Math.round(st.stock * 2) / 2 : med.stock))}">
        </label>
        <label class="field-label">Count date *
          <input type="date" class="input" id="stock-date" value="${esc(todayStr())}">
        </label>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-stock">Save</button>
    </div>
  `);

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);
  document.getElementById('btn-save-stock').addEventListener('click', async () => {
    const stock = parseFloat(document.getElementById('stock-val').value);
    const date  = document.getElementById('stock-date').value;
    if (isNaN(stock) || !date) { toast('Please fill in all fields', 'error'); return; }
    await dbPut(S.MEDICATIONS, { ...med, stock, stockDate: date });
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast('Stock updated');
  });
}

/* ──── Doctor modal ──── */
async function openDoctorModal(docId = null) {
  const doc = docId ? await dbGet(S.DOCTORS, docId) : null;

  openModal(`
    <div class="modal-header">
      <h2>${docId ? 'Edit' : 'Add'} Doctor</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      <label class="field-label">Name *
        <input class="input" id="doc-name" value="${esc(doc?.name??'')}" placeholder="Dr. Müller">
      </label>
      <div class="field-row">
        <label class="field-label">Specialty
          <input class="input" id="doc-spec" value="${esc(doc?.specialty??'')}" placeholder="Psychiatry">
        </label>
        <label class="field-label">Phone
          <input class="input" id="doc-phone" value="${esc(doc?.phone??'')}" placeholder="030 123456">
        </label>
      </div>
      <label class="field-label">Address / Practice
        <input class="input" id="doc-addr" value="${esc(doc?.address??'')}" placeholder="Berliner Str. 1, 10115 Berlin">
      </label>
      <label class="field-label">Notes
        <textarea class="input" id="doc-notes" rows="2">${esc(doc?.notes??'')}</textarea>
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-doc">Save</button>
    </div>
  `);

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);
  document.getElementById('btn-save-doc').addEventListener('click', async () => {
    const name = document.getElementById('doc-name').value.trim();
    if (!name) { toast('Doctor name is required', 'error'); return; }
    await dbPut(S.DOCTORS, {
      ...(doc ?? {}),
      name,
      specialty: document.getElementById('doc-spec').value.trim(),
      phone    : document.getElementById('doc-phone').value.trim(),
      address  : document.getElementById('doc-addr').value.trim(),
      notes    : document.getElementById('doc-notes').value.trim(),
    });
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast(docId ? 'Doctor updated' : 'Doctor added');
  });
}

/* ──── Appointment modal ──── */
async function openAppointmentModal(apptId = null, presetDate = null) {
  const appt = apptId ? await dbGet(S.APPOINTMENTS, apptId) : null;

  const typeOptions = APPT_TYPES.map((t) =>
    `<option value="${t.value}" ${(appt?.type??'checkup')===t.value?'selected':''}>${esc(t.label)}</option>`
  ).join('');

  openModal(`
    <div class="modal-header">
      <h2>${apptId ? 'Edit' : 'Add'} Appointment</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      <label class="field-label">Doctor *
        <select class="input" id="appt-doc">${doctorOptions(appt?.doctorId??null, '— Select doctor —')}</select>
      </label>
      <div class="field-row">
        <label class="field-label">Date *
          <input type="date" class="input" id="appt-date" value="${esc(appt?.date ?? presetDate ?? todayStr())}">
        </label>
        <label class="field-label">Time
          <input type="time" class="input" id="appt-time" value="${esc(appt?.time??'')}">
        </label>
      </div>
      <label class="field-label">Type
        <select class="input" id="appt-type">${typeOptions}</select>
      </label>
      <label class="field-label">Notes
        <textarea class="input" id="appt-notes" rows="2">${esc(appt?.notes??'')}</textarea>
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-appt">Save</button>
    </div>
  `);

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);
  document.getElementById('btn-save-appt').addEventListener('click', async () => {
    const docId = Number(document.getElementById('appt-doc').value) || null;
    const date  = document.getElementById('appt-date').value;
    if (!date) { toast('Date is required', 'error'); return; }
    await dbPut(S.APPOINTMENTS, {
      ...(appt ?? {}),
      doctorId: docId,
      date,
      time : document.getElementById('appt-time').value || null,
      type : document.getElementById('appt-type').value,
      notes: document.getElementById('appt-notes').value.trim(),
    });
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast(apptId ? 'Appointment updated' : 'Appointment added');
  });
}

/* ──── Formulary modal ──── */
async function openFormularyModal(entryId = null) {
  const entry = entryId ? await dbGet(S.FORMULARY, entryId) : null;

  openModal(`
    <div class="modal-header">
      <h2>${entryId ? 'Edit' : 'Add'} Database Entry</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      <div class="field-row">
        <label class="field-label">Trade name *
          <input class="input" id="f-trade" value="${esc(entry?.tradeName??'')}" placeholder="Metoprolol Ratiopharm">
        </label>
        <label class="field-label">Generic name *
          <input class="input" id="f-generic" value="${esc(entry?.genericName??'')}" placeholder="Metoprolol">
        </label>
      </div>
      <div class="field-row">
        <label class="field-label">Strength <input class="input" id="f-strength" value="${esc(entry?.strength??'')}" placeholder="50 mg"></label>
        <label class="field-label">Form     <input class="input" id="f-form"     value="${esc(entry?.form??'')}"     placeholder="Tabletten"></label>
        <label class="field-label">Hersteller <input class="input" id="f-mfr"   value="${esc(entry?.manufacturer??'')}"></label>
      </div>
      <p class="field-hint">German N-pack sizes (units per pack)</p>
      <div class="field-row">
        <label class="field-label">N1 <input type="number" class="input" id="f-n1" min="0" value="${esc(String(entry?.n1??''))}"></label>
        <label class="field-label">N2 <input type="number" class="input" id="f-n2" min="0" value="${esc(String(entry?.n2??''))}"></label>
        <label class="field-label">N3 <input type="number" class="input" id="f-n3" min="0" value="${esc(String(entry?.n3??''))}"></label>
      </div>
      <label class="field-label">Side effects / producer notes
        <textarea class="input" id="f-se" rows="3">${esc(entry?.sideEffects??'')}</textarea>
      </label>
      <label class="field-label">General notes
        <textarea class="input" id="f-notes" rows="2">${esc(entry?.notes??'')}</textarea>
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-form">Save</button>
    </div>
  `);

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);
  document.getElementById('btn-save-form').addEventListener('click', async () => {
    const trade  = document.getElementById('f-trade').value.trim();
    const generic= document.getElementById('f-generic').value.trim();
    if (!trade || !generic) { toast('Trade name and generic name are required', 'error'); return; }
    await dbPut(S.FORMULARY, {
      ...(entry ?? {}),
      tradeName   : trade,
      genericName : generic,
      strength    : document.getElementById('f-strength').value.trim(),
      form        : document.getElementById('f-form').value.trim(),
      manufacturer: document.getElementById('f-mfr').value.trim(),
      n1          : parseInt(document.getElementById('f-n1').value)  || null,
      n2          : parseInt(document.getElementById('f-n2').value)  || null,
      n3          : parseInt(document.getElementById('f-n3').value)  || null,
      sideEffects : document.getElementById('f-se').value.trim(),
      notes       : document.getElementById('f-notes').value.trim(),
    });
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast(entryId ? 'Entry updated' : 'Entry added');
  });
}

/* ──── Refill modal ──── */
async function openRefillModal(medIdPreset = null) {
  const { medications } = App.state;
  const active = medications.filter((m) => m.active);

  openModal(`
    <div class="modal-header">
      <h2>Log Refill</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      <label class="field-label">Medication *
        <select class="input" id="ref-med">
          <option value="">— Select —</option>
          ${active.map((m) =>
            `<option value="${m.id}" ${m.id===medIdPreset?'selected':''}>${esc(m.tradeName)}</option>`
          ).join('')}
        </select>
      </label>
      <div class="field-row">
        <label class="field-label">Amount received *
          <input type="number" class="input" id="ref-amount" step="0.5" min="0.5">
        </label>
        <label class="field-label">Pack size
          <select class="input" id="ref-pack">
            <option value="">—</option>
            <option>N1</option><option>N2</option><option>N3</option>
          </select>
        </label>
      </div>
      <div class="field-row">
        <label class="field-label">Date *
          <input type="date" class="input" id="ref-date" value="${esc(todayStr())}">
        </label>
        <label class="field-label">Manufacturer
          <input class="input" id="ref-mfr">
        </label>
      </div>
      <label class="field-label">Side effects / notes
        <textarea class="input" id="ref-notes" rows="2" placeholder="Differences in tolerability with this producer?"></textarea>
      </label>
      <label class="input-check">
        <input type="checkbox" id="ref-update-stock" checked>
        Add received amount to current stock
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-refill">Log refill</button>
    </div>
  `);

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);
  document.getElementById('btn-save-refill').addEventListener('click', async () => {
    const medId  = Number(document.getElementById('ref-med').value);
    const amount = parseFloat(document.getElementById('ref-amount').value);
    const date   = document.getElementById('ref-date').value;
    if (!medId || isNaN(amount) || !date) { toast('Please fill in required fields', 'error'); return; }

    await dbPut(S.REFILL_LOGS, {
      medicationId: medId,
      date,
      amount,
      packSize    : document.getElementById('ref-pack').value  || null,
      manufacturer: document.getElementById('ref-mfr').value.trim() || null,
      notes       : document.getElementById('ref-notes').value.trim() || null,
    });

    if (document.getElementById('ref-update-stock').checked) {
      const med     = await dbGet(S.MEDICATIONS, medId);
      const refills = await loadRefillsForMed(medId);
      const logs    = await loadLogsForMed(medId);
      const current = effectiveStock(med, refills, logs);
      await dbPut(S.MEDICATIONS, { ...med, stock: current + amount, stockDate: date });
    }

    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast('Refill logged');
  });
}

/* ──── Vacation modal ──── */
async function openVacationModal(vacId = null) {
  const vac = vacId ? await dbGet(S.VACATIONS, vacId) : null;

  openModal(`
    <div class="modal-header">
      <h2>${vacId ? 'Edit' : 'Add'} Vacation / Absence</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      <label class="field-label">Type *
        <select class="input" id="vac-type">
          <option value="mine"   ${vac?.type==='mine'  ?'selected':''}>🌴 My vacation</option>
          <option value="doctor" ${vac?.type==='doctor'?'selected':''}>🏥 Doctor's vacation / practice closure</option>
        </select>
      </label>
      <label class="field-label">Doctor (leave empty to affect all medications)
        <select class="input" id="vac-doctor">${doctorOptions(vac?.doctorId??null)}</select>
      </label>
      <label class="field-label">Label / name
        <input class="input" id="vac-label" value="${esc(vac?.label??'')}" placeholder="Summer holiday / Dr. Müller away">
      </label>
      <div class="field-row">
        <label class="field-label">Start date * <input type="date" class="input" id="vac-start" value="${esc(vac?.startDate??'')}"></label>
        <label class="field-label">End date *   <input type="date" class="input" id="vac-end"   value="${esc(vac?.endDate??'')}"></label>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn--ghost" id="btn-modal-close2">Cancel</button>
      <button class="btn btn--primary" id="btn-save-vac">Save</button>
    </div>
  `);

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);
  document.getElementById('btn-save-vac').addEventListener('click', async () => {
    const start = document.getElementById('vac-start').value;
    const end   = document.getElementById('vac-end').value;
    if (!start || !end)   { toast('Start and end dates required', 'error'); return; }
    if (end < start)      { toast('End date must be after start date', 'error'); return; }
    await dbPut(S.VACATIONS, {
      ...(vac ?? {}),
      type    : document.getElementById('vac-type').value,
      doctorId: Number(document.getElementById('vac-doctor').value) || null,
      label   : document.getElementById('vac-label').value.trim(),
      startDate: start,
      endDate  : end,
    });
    await loadAll();
    renderView(App.state.view);
    closeModal();
    toast('Vacation period saved');
  });
}

/* ══════════════════════════════════════
   DELETE / ARCHIVE HELPERS
══════════════════════════════════════ */

async function toggleArchiveMed(medId) {
  const med = await dbGet(S.MEDICATIONS, medId);
  if (!med) return;
  await dbPut(S.MEDICATIONS, { ...med, active: !med.active });
  await loadAll(); renderView(App.state.view);
  toast(med.active ? 'Medication archived' : 'Medication restored');
}

async function deleteMedication(medId) {
  if (!confirm('Permanently delete this medication and all its logs? This cannot be undone.')) return;
  await dbDelete(S.MEDICATIONS, medId);
  // Also clean up associated logs and refills for tidiness
  const logs    = await loadLogsForMed(medId);
  const refills = await loadRefillsForMed(medId);
  await Promise.all([...logs.map((l) => dbDelete(S.DAILY_LOGS, l.id)), ...refills.map((r) => dbDelete(S.REFILL_LOGS, r.id))]);
  await loadAll(); renderView(App.state.view);
  toast('Medication deleted');
}

async function deleteFormularyEntry(id) {
  if (!confirm('Delete this database entry?')) return;
  await dbDelete(S.FORMULARY, id);
  await loadAll(); renderView(App.state.view);
  toast('Entry deleted');
}

async function deleteRefill(id) {
  if (!confirm('Delete this refill record?')) return;
  await dbDelete(S.REFILL_LOGS, id);
  await loadAll(); renderView(App.state.view);
  toast('Refill record deleted');
}

async function deleteVacation(id) {
  if (!confirm('Delete this vacation period?')) return;
  await dbDelete(S.VACATIONS, id);
  await loadAll(); renderView(App.state.view);
  toast('Vacation period deleted');
}

async function deleteDoctor(id) {
  const linked = App.state.medications.filter((m) => m.doctorId === id).length
               + App.state.vacations.filter((v) => v.doctorId === id).length
               + App.state.appointments.filter((a) => a.doctorId === id).length;
  if (linked > 0 && !confirm(`This doctor is linked to ${linked} record(s). Deleting will unlink them. Continue?`)) return;
  // Unlink before delete
  for (const m of App.state.medications.filter((m) => m.doctorId === id)) {
    await dbPut(S.MEDICATIONS, { ...m, doctorId: null });
  }
  for (const v of App.state.vacations.filter((v) => v.doctorId === id)) {
    await dbPut(S.VACATIONS, { ...v, doctorId: null });
  }
  await dbDelete(S.DOCTORS, id);
  await loadAll(); renderView(App.state.view);
  toast('Doctor deleted');
}

async function deleteAppointment(id) {
  if (!confirm('Delete this appointment?')) return;
  await dbDelete(S.APPOINTMENTS, id);
  await loadAll(); renderView(App.state.view);
  toast('Appointment deleted');
}

/* ══════════════════════════════════════
   EXPORT / IMPORT
══════════════════════════════════════ */

/**
 * exportData — three-tier fallback for maximum compatibility.
 *
 * Tier 1: Blob URL + <a download>  — works in desktop browsers and most mobile browsers.
 * Tier 2: data: URI + <a download> — works in some Android WebViews that block blob URLs.
 * Tier 3: Copy-modal               — fallback for web-to-app WebViews (e.g. web2apk, GoNative)
 *                                    that block all programmatic downloads. Shows the raw JSON
 *                                    in a textarea the user can select-all and copy manually,
 *                                    or long-press to share via the Android share sheet.
 */
async function exportData() {
  // Gather all data from IndexedDB
  const [formulary, medications, daily_logs, refill_logs, vacations, doctors, appointments, settings] = await Promise.all([
    dbGetAll(S.FORMULARY), dbGetAll(S.MEDICATIONS), dbGetAll(S.DAILY_LOGS),
    dbGetAll(S.REFILL_LOGS), dbGetAll(S.VACATIONS), dbGetAll(S.DOCTORS),
    dbGetAll(S.APPOINTMENTS), dbGetAll(S.SETTINGS),
  ]);

  const payload = {
    _version: 2, _exportedAt: new Date().toISOString(),
    formulary, medications, daily_logs, refill_logs, vacations, doctors, appointments, settings,
  };

  const jsonStr  = JSON.stringify(payload, null, 2);
  const filename = `medtracker-backup-${todayStr()}.json`;

  // ── Tier 1: Blob URL (standard browsers) ────────────────────────────────
  if (typeof URL.createObjectURL === 'function') {
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Give the browser a moment to initiate the download before revoking
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('Backup downloaded');
      return;
    } catch (_) { /* fall through to next tier */ }
  }

  // ── Tier 2: data: URI (some Android WebViews) ────────────────────────────
  try {
    // encodeURIComponent handles unicode safely; data URIs work in more WebViews
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);
    const a = Object.assign(document.createElement('a'), { href: dataUri, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('Backup downloaded');
    return;
  } catch (_) { /* fall through to copy modal */ }

  // ── Tier 3: Copy modal (WebView with no download support) ────────────────
  // Show the full JSON in a scrollable textarea. The user can:
  //   • Tap "Copy to clipboard" (if the Clipboard API is available)
  //   • Select All → Copy manually
  //   • On Android: long-press → Share to save to Drive/email/etc.
  showExportCopyModal(jsonStr, filename);
}

/** Renders the fallback copy modal with the raw JSON */
function showExportCopyModal(jsonStr, filename) {
  openModal(`
    <div class="modal-header">
      <h2>Save Backup Manually</h2>
      <button class="modal-close" id="btn-modal-close">×</button>
    </div>
    <div class="modal-body">
      <p class="view-desc">
        Automatic download is not supported in this environment.
        Copy the text below and paste it into a text file saved as
        <strong>${esc(filename)}</strong>, or share it to Google Drive / email.
      </p>
      <div style="position:relative">
        <textarea id="export-json-area" class="input" rows="10"
          style="font-family:monospace;font-size:.72rem;resize:vertical"
          readonly>${esc(jsonStr)}</textarea>
      </div>
    </div>
    <div class="modal-footer" style="flex-wrap:wrap;gap:.5rem">
      <button class="btn btn--ghost" id="btn-modal-close2">Close</button>
      <button class="btn btn--primary" id="btn-copy-json">📋 Copy to clipboard</button>
    </div>
  `);

  // Select all text immediately so the user can see it is ready
  const area = document.getElementById('export-json-area');
  area.addEventListener('focus', () => area.select());
  area.select();

  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-modal-close2').addEventListener('click', closeModal);

  document.getElementById('btn-copy-json').addEventListener('click', async () => {
    try {
      // Modern Clipboard API — works in secure contexts (https)
      await navigator.clipboard.writeText(jsonStr);
      toast('Copied to clipboard — paste into a .json file');
    } catch (_) {
      // Fallback: select the textarea so the user can copy manually
      area.select();
      document.execCommand('copy'); // deprecated but widely supported in WebViews
      toast('Copied — paste into a .json file');
    }
  });
}

async function importData(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (!payload._version) { toast('Unrecognised backup format', 'error'); return; }
    const storeMap = {
      formulary: S.FORMULARY, medications: S.MEDICATIONS, daily_logs: S.DAILY_LOGS,
      refill_logs: S.REFILL_LOGS, vacations: S.VACATIONS, doctors: S.DOCTORS,
      appointments: S.APPOINTMENTS, settings: S.SETTINGS,
    };
    let added = 0, skipped = 0;
    for (const [key, store] of Object.entries(storeMap)) {
      const records = payload[key];
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (store === S.SETTINGS) { await dbPut(store, record); added++; continue; }
        if (record.id != null) {
          const existing = await dbGet(store, record.id);
          if (existing) { skipped++; continue; }
        }
        await dbPut(store, record); added++;
      }
    }
    await loadAll(); renderView(App.state.view);
    toast(`Import done: ${added} added, ${skipped} already existed`);
  } catch (err) {
    console.error(err); toast('Import failed — check the file format', 'error');
  }
}

/* ══════════════════════════════════════
   EVENTS
══════════════════════════════════════ */

function wireEvents() {
  document.querySelectorAll('[data-nav]').forEach((btn) =>
    btn.addEventListener('click', () => setView(btn.dataset.nav))
  );

  document.getElementById('btn-prev-month').addEventListener('click', () => {
    let { year, month } = App.state;
    month--; if (month < 0) { month = 11; year--; }
    App.state.year = year; App.state.month = month;
    renderCalendar(); renderSidebar();
  });

  document.getElementById('btn-next-month').addEventListener('click', () => {
    let { year, month } = App.state;
    month++; if (month > 11) { month = 0; year++; }
    App.state.year = year; App.state.month = month;
    renderCalendar(); renderSidebar();
  });

  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  document.getElementById('btn-quick-refill')?.addEventListener('click', () => openRefillModal());
}

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }
  await loadAll();
  wireEvents();
  setView('calendar');
}

document.addEventListener('DOMContentLoaded', init);
