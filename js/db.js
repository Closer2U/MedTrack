/**
 * db.js — IndexedDB wrapper for MedTracker
 * ==========================================
 * Version history:
 *   v1 — initial schema
 *   v2 — added `doctors` and `appointments` stores;
 *         medications and vacations now carry a doctorId foreign key
 *
 * To add a new store in a future version:
 *   1. Bump DB_VER
 *   2. Add an `if (oldVersion < N)` block in onupgradeneeded
 *   3. Add any needed helpers below
 */

const DB_NAME = 'MedTrackerDB';
const DB_VER  = 2;

/** Store name constants — use these everywhere instead of raw strings */
const S = {
  FORMULARY   : 'formulary',
  MEDICATIONS : 'medications',
  DAILY_LOGS  : 'daily_logs',
  REFILL_LOGS : 'refill_logs',
  VACATIONS   : 'vacations',
  DOCTORS     : 'doctors',
  APPOINTMENTS: 'appointments',
  SETTINGS    : 'settings',
};

let _db = null;

/* ─────────────── Open / Init ─────────────── */

function dbOpen() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = ({ oldVersion, target: { result: db } }) => {

      // ── Version 1 stores ─────────────────────────────────────────────────
      if (oldVersion < 1) {
        const f = db.createObjectStore(S.FORMULARY, { keyPath: 'id', autoIncrement: true });
        f.createIndex('genericName', 'genericName');
        f.createIndex('tradeName',   'tradeName');

        const m = db.createObjectStore(S.MEDICATIONS, { keyPath: 'id', autoIncrement: true });
        m.createIndex('active', 'active');

        // Compound index lets us find/update a specific (med, date) pair fast
        const l = db.createObjectStore(S.DAILY_LOGS, { keyPath: 'id', autoIncrement: true });
        l.createIndex('medicationId', 'medicationId');
        l.createIndex('date',         'date');
        l.createIndex('medDate',      ['medicationId', 'date'], { unique: false });

        const r = db.createObjectStore(S.REFILL_LOGS, { keyPath: 'id', autoIncrement: true });
        r.createIndex('medicationId', 'medicationId');
        r.createIndex('date',         'date');

        db.createObjectStore(S.VACATIONS, { keyPath: 'id', autoIncrement: true });
        db.createObjectStore(S.SETTINGS,  { keyPath: 'key' });
      }

      // ── Version 2 additions ───────────────────────────────────────────────
      if (oldVersion < 2) {
        // Doctors — linked from medications.doctorId, vacations.doctorId, appointments.doctorId
        if (!db.objectStoreNames.contains(S.DOCTORS)) {
          const d = db.createObjectStore(S.DOCTORS, { keyPath: 'id', autoIncrement: true });
          d.createIndex('name', 'name');
        }

        // Appointments — one entry per visit, linked to a doctor
        if (!db.objectStoreNames.contains(S.APPOINTMENTS)) {
          const a = db.createObjectStore(S.APPOINTMENTS, { keyPath: 'id', autoIncrement: true });
          a.createIndex('doctorId', 'doctorId');
          a.createIndex('date',     'date');
        }
      }
    };

    req.onsuccess = ({ target: { result } }) => { _db = result; resolve(_db); };
    req.onerror   = ({ target: { error  } }) => reject(error);
  });
}

/* ─────────────── Generic CRUD ─────────────── */

async function dbGetAll(store) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function dbGet(store, id) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

/** Upsert — omit id to insert, include id to update */
async function dbPut(store, item) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(item);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function dbDelete(store, id) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

async function dbGetByIndex(store, indexName, value) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly')
      .objectStore(store).index(indexName).getAll(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

/** Find a single daily log by (medicationId, date) via the compound index */
async function dbGetLog(medicationId, date) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const req = db.transaction(S.DAILY_LOGS, 'readonly')
      .objectStore(S.DAILY_LOGS)
      .index('medDate')
      .get([medicationId, date]);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

/* ─────────────── Settings helpers ─────────────── */

async function settingGet(key, defaultVal = null) {
  const db = await dbOpen();
  return new Promise((res) => {
    const req = db.transaction(S.SETTINGS, 'readonly').objectStore(S.SETTINGS).get(key);
    req.onsuccess = () => res(req.result ? req.result.value : defaultVal);
    req.onerror   = () => res(defaultVal);
  });
}

async function settingSet(key, value) {
  return dbPut(S.SETTINGS, { key, value });
}

/* ─────────────── Convenience loaders ─────────────── */

async function loadActiveMeds() {
  const all = await dbGetAll(S.MEDICATIONS);
  return all.filter((m) => m.active);
}

async function loadLogsForMed(medId) {
  return dbGetByIndex(S.DAILY_LOGS, 'medicationId', medId);
}

async function loadRefillsForMed(medId) {
  return dbGetByIndex(S.REFILL_LOGS, 'medicationId', medId);
}

async function loadAppointmentsForDate(date) {
  return dbGetByIndex(S.APPOINTMENTS, 'date', date);
}
