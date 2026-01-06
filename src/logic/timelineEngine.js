// src/logic/timelineEngine.js

// --------------------------------------------------------
// RÜHRWERKDEFINITIONEN (echte Namen + min/max Liter)
// --------------------------------------------------------
export const reactors = [
  // Große RW
  { id: "A1", name: "A1", min: 5000, max: 13000, type: "big" },
  { id: "A2", name: "A2", min: 5000, max: 13000, type: "big" },
  { id: "RW09", name: "RW09", min: 5000, max: 13000, type: "big" },
  { id: "RW10", name: "RW10", min: 5000, max: 13000, type: "big" },
  { id: "RW11", name: "RW11", min: 5000, max: 13000, type: "big" },

  // Kleine / mittlere RW
  { id: "RW05", name: "RW05", min: 2000, max: 7500, type: "small" },
  { id: "RW04", name: "RW04", min: 1500, max: 7000, type: "small" },
  { id: "RW02", name: "RW02", min: 700, max: 5000, type: "small" },
  { id: "RW01", name: "RW01", min: 700, max: 4900, type: "small" },
  { id: "RW03-Y", name: "RW03-Y", min: 500, max: 4700, type: "small" },

  // Sonderfall – nicht automatisch nutzen!
  { id: "Ex-Diss", name: "Ex-Diss", min: 150, max: 1000, type: "special" }
];

export const productionLanes = reactors.filter(r => r.type !== "special").map(r => r.id);
export const fillingLanes = ["Linie1", "Linie2", "Linie3", "Linie4", "Linie5"];
export const ibcLane = "IBC";

// --------------------------------------------------------
// UI/RENDER HELPERS
// --------------------------------------------------------
export function minutesToPixels(min, scale) {
  return min * scale;
}

export function computeTimelineBounds(events) {
  if (!events || events.length === 0) return { min: 0, max: 600 };

  const minStart = Math.min(0, ...events.map(e => (e?.start ?? 0)));
  const maxEnd = Math.max(0, ...events.map(e => (e?.end ?? 0)));

  return {
    min: minStart,
    max: maxEnd + 200
  };
}




export function generateDummyEvents() {
  return [];
}

// --------------------------------------------------------
// ERLAUBTE RÜHRWERKE FÜR VOLUMEN (min/max strikt, klein->groß)
// --------------------------------------------------------
export function getAllowedRWsForVolume(volumeL) {
  return reactors
    .filter(rw => rw.type !== "special" && volumeL >= rw.min && volumeL <= rw.max)
    .sort((a, b) => a.max - b.max)
    .map(rw => rw.id);
}

// --------------------------------------------------------
// OVERLAP CHECK (isRWFree) – gilt für rwBatch + cleaning + ibcRWSlot
// --------------------------------------------------------
export function isRWFree(events, rwId, start, end) {
  if (!Array.isArray(events)) return false;
  const list = events.filter(e => e.lane === rwId);
  for (const ev of list) {
    const s = ev.start ?? 0;
    const t = ev.end ?? 0;
    const overlap = !(end <= s || start >= t);
    if (overlap) return false;
  }
  return true;
}

export function getLastEndForLane(events, lane) {
  if (!Array.isArray(events)) return 0;
  const list = events.filter(e => e.lane === lane);
  if (list.length === 0) return 0;
  return Math.max(...list.map(e => e.end ?? 0));
}

// --------------------------------------------------------
// BATCHING v0.2: Split-Variante erzeugen (gleichmäßig, keine Mini-Reste)
// -> wird vom Planner genutzt, um 5–12 Kandidaten zu bauen
// --------------------------------------------------------
export function makeEqualSplit(total, n) {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  const arr = Array(n).fill(base);
  for (let i = 0; i < rest; i++) arr[i] += 1;
  return arr;
}

// --------------------------------------------------------
// Volume-Fit Penalty (kleine Batches nicht in big, große nicht in small)
// --------------------------------------------------------
export function getVolumeFitPenalty(volumeL, rwId) {
  const r = reactors.find(x => x.id === rwId);
  if (!r) return 999;

  if (volumeL < 7000 && r.type === "big") return 10;
  if (volumeL > 7500 && r.type === "small") return 10;

  const waste = r.max - volumeL;
  return Math.max(0, waste / 1000);
}

// --------------------------------------------------------
// RW SLOT (EIN EVENT pro Batch) – DIRECT
// belegt: prodStart -> lastFillEnd
// phases: production + fillingSegments[] + cleaning optional
// --------------------------------------------------------
export function buildRwBatchEvent({
  rwId,
  productId,
  volumeL,
  prodStart,
  prodEnd,
  lastFillEnd,
  fillingSegments,
  locked = false,
  mode = "DIRECT" // DIRECT | IBC
}) {
  return {
    id: "rwBatch_" + crypto.randomUUID(),
    type: "rwBatch",
    lane: rwId,
    rwId,
    productId,
    volumeL,
    start: prodStart,
    end: lastFillEnd,
    locked,
    mode,
    label: `${locked ? "IST" : "GEPLANT"} · ${productId} · ${Math.round(volumeL)}L`,
    color: locked ? "#f97316" : "#94a3b8",
    phases: {
      production: { start: prodStart, end: prodEnd },
      fillingSegments: fillingSegments || [],
      cleaning: null,
      ibcFilling: null
    }
  };
}

// --------------------------------------------------------
// Scoring-basiert bestes RW finden (kann später erweitert werden)
// --------------------------------------------------------
export function findBestRW({ volumeL, productId, slotStart, slotEnd, events, candidates }) {
  let best = null;

  for (const rwId of candidates) {
    if (!isRWFree(events, rwId, slotStart, slotEnd)) continue;

    const lastEnd = getLastEndForLane(events, rwId);
    const idleGap = Math.max(0, slotStart - lastEnd);
    const fitPenalty = getVolumeFitPenalty(volumeL, rwId);

    // fragmentationPenalty (simple): wenn Lücke, dann schlecht
    const fragmentationPenalty = idleGap > 0 ? 1 : 0;

    const score = idleGap * 2 + fitPenalty * 5 + fragmentationPenalty * 3;

    if (!best || score < best.score) {
      best = { rwId, score };
    }
  }

  return best;
}
// --------------------------------------------------------
// NORMALIZER + VALIDATOR (Merge-Gate Schritt 4)
// --------------------------------------------------------

const LANE_TYPE_ORDER = { LINE: 0, RW: 1, IBC: 2 };
const TYPE_PRIORITY = {
  // feste Reihenfolge, damit Sorting stabil bleibt
  lineFill: 10,
  rwBatch: 20,
  "rw-slot": 20,
  ibcBatch: 30,
  cleaning: 40,
  blocked: 50,
  unknown: 99
};

function clamp0(n) {
  return n < 0 ? 0 : n;
}

export function quantFloor(t, stepMin) {
  return Math.floor(t / stepMin) * stepMin;
}

export function quantCeil(t, stepMin) {
  return Math.ceil(t / stepMin) * stepMin;
}

// deterministischer Hash (FNV-1a)
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

function canonicalLane(e) {
  // already canonical?
  if (e.laneType && e.laneId) return { laneType: e.laneType, laneId: e.laneId };

  // legacy: lane string
  const lane = e.lane || e.laneId || "";
  if (/^Linie\d+$/.test(lane)) {
    const n = lane.replace("Linie", "");
    return { laneType: "LINE", laneId: `L${n}` };
  }
  if (lane === "IBC") return { laneType: "IBC", laneId: "IBC" };

  // sonst: RW (A1, RW09, ...)
  return { laneType: "RW", laneId: lane };
}

function typePriority(type) {
  return TYPE_PRIORITY[type] ?? TYPE_PRIORITY.unknown;
}

function canonicalSort(a, b) {
  const ao = LANE_TYPE_ORDER[a.laneType] ?? 99;
  const bo = LANE_TYPE_ORDER[b.laneType] ?? 99;
  if (ao !== bo) return ao - bo;

  if (a.laneId !== b.laneId) return String(a.laneId).localeCompare(String(b.laneId));

  if (a.qStart !== b.qStart) return a.qStart - b.qStart;
  if (a.qEnd !== b.qEnd) return a.qEnd - b.qEnd;

  const ap = typePriority(a.type);
  const bp = typePriority(b.type);
  if (ap !== bp) return ap - bp;

  return String(a.id).localeCompare(String(b.id));
}

export function normalizeEvents(rawEvents, cfg) {
  const stepMin = Number(cfg?.stepMin ?? 5);
  const diagnostics = [];

  const arr = Array.isArray(rawEvents) ? rawEvents : [];
  const normalized = arr.map((src, idx) => {
    const e = { ...src };

    // lane canonical
    const { laneType, laneId } = canonicalLane(e);
    e.laneType = laneType;
    e.laneId = laneId;

    // type canonical (falls bei manchen Events nicht gesetzt)
    if (!e.type) {
      // Fallback: alte Labels erkennen (optional)
      if (e.label?.startsWith("Abfüllung")) e.type = "lineFill";
      else e.type = "unknown";
    }

    // times
    const start = Number(e.start ?? 0);
    const end = Number(e.end ?? start);
    e.start = Number.isFinite(start) ? start : 0;
    e.end = Number.isFinite(end) ? end : e.start;

    // quantize conservative
    e.qStart = clamp0(quantFloor(e.start, stepMin));
    e.qEnd = clamp0(quantCeil(e.end, stepMin));
    if (e.qEnd < e.qStart + stepMin) e.qEnd = e.qStart + stepMin;

    // deterministic id if missing
    if (!e.id) {
      const base = [
        e.type,
        e.laneType,
        e.laneId,
        e.productId ?? e.product ?? "",
        e.orderId ?? "",
        e.volumeL ?? e.volume ?? "",
        e.qStart,
        e.qEnd,
        e.lockKind ?? ""
      ].join("|");
      e.id = `${e.type}_${fnv1a(base)}_${idx}`;
    }

    return e;
  });

  normalized.sort(canonicalSort);

  return { events: normalized, diagnostics };
}

// Welche Events blockieren RW?
function blocksRW(e) {
  // RW-Lane: fast alles blockiert – außer reine Anzeigeobjekte
  // (lineFill liegt auf LINE laneType, ibcBatch auf IBC)
  if (e.laneType !== "RW") return false;
  if (e.type === "lineFill") return false;
  return true;
}

export function validatePlan(events, cfg) {
  const diagnostics = [];
  const stepMin = Number(cfg?.stepMin ?? 5);

  const arr = Array.isArray(events) ? events : [];

  // basic invariants
  for (const e of arr) {
    if (!e.laneType || !e.laneId) {
      diagnostics.push({ code: "LANE_NOT_CANONICAL", eventId: e.id });
    }
    if (!Number.isFinite(e.qStart) || !Number.isFinite(e.qEnd)) {
      diagnostics.push({ code: "QTIMES_INVALID", eventId: e.id });
    } else if (e.qEnd < e.qStart + stepMin) {
      diagnostics.push({ code: "QTIMES_TOO_SHORT", eventId: e.id, qStart: e.qStart, qEnd: e.qEnd });
    }
  }

  // RW overlap check (qTimes only)
  const byRW = new Map();
  for (const e of arr) {
    if (!blocksRW(e)) continue;
    const key = e.laneId;
    if (!byRW.has(key)) byRW.set(key, []);
    byRW.get(key).push(e);
  }

  for (const [rwId, list] of byRW.entries()) {
    list.sort((a, b) => (a.qStart - b.qStart) || (a.qEnd - b.qEnd) || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.qStart < prev.qEnd) {
        diagnostics.push({
          code: "RW_OVERLAP",
          rwId,
          a: prev.id,
          b: cur.id,
          window: { a: [prev.qStart, prev.qEnd], b: [cur.qStart, cur.qEnd] }
        });
      }
    }
  }

  return { ok: diagnostics.length === 0, diagnostics };
}

export function computePlanHash(events) {
  const arr = Array.isArray(events) ? events : [];
  const parts = arr.map(e => {
    const consumers = Array.isArray(e.consumers)
      ? [...e.consumers].sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)))
      : [];
    return [
      e.id,
      e.laneType,
      e.laneId,
      e.qStart,
      e.qEnd,
      e.type,
      e.productId ?? e.product ?? "",
      e.volumeL ?? e.volume ?? "",
      e.lockKind ?? "",
      JSON.stringify(consumers)
    ].join(",");
  });
  return fnv1a(parts.join("\n"));
}
