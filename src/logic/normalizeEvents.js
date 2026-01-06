// src/logic/normalizeEvents.js

const LANE_TYPE_ORDER = { LINE: 1, RW: 2, IBC: 3 };

const TYPE_PRIORITY = {
  // klein = früher in Sortierung (stabil)
  blocked: 1,
  rwBatch: 2,
  lineFill: 3,
  ibcBatch: 4,
};

export function fnv1a32(str) {
  // deterministischer 32-bit Hash (FNV-1a)
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function stableId(prefix, parts) {
  const s = JSON.stringify(parts);
  const hex = fnv1a32(s).toString(16).padStart(8, "0");
  return `${prefix}_${hex}`;
}

export function canonicalizeLane(ev) {
  // Canonical Contract: laneType + laneId (aliases nur raw; hier nur robustes Mapping)
  // LINE: "Linie1".."Linie5" oder "L1".."L5"
  // IBC: lane/type ibcBatch oder lane "IBC"
  // RW: alles andere (A1, A2, RW09, ...)
  const rawLane = ev.laneId || ev.lane || ev.lineId || "";

  // IBC
  if (ev.laneType === "IBC" || ev.type === "ibcBatch" || rawLane === "IBC") {
    return { laneType: "IBC", laneId: "IBC" };
  }

  // LINE
  if (ev.laneType === "LINE") {
    // laneId muss "Lx" sein
    if (String(ev.laneId || "").match(/^L[1-5]$/)) return { laneType: "LINE", laneId: ev.laneId };
  }
  if (String(rawLane).match(/^L[1-5]$/)) return { laneType: "LINE", laneId: rawLane };
  const m = String(rawLane).match(/^Linie(\d)$/i);
  if (m) return { laneType: "LINE", laneId: `L${m[1]}` };

  // RW fallback
  return { laneType: "RW", laneId: String(rawLane) || "RW_UNK" };
}

export function quantizeTimes(start, end, stepMin) {
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end) ? end : s + stepMin;

  const clampS = Math.max(0, s);
  const clampE = Math.max(clampS + stepMin, e);

  const qStart = Math.floor(clampS / stepMin) * stepMin;
  const qEnd = Math.ceil(clampE / stepMin) * stepMin;

  // Safety: niemals 0-Länge
  const safeEnd = Math.max(qEnd, qStart + stepMin);

  return { qStart, qEnd: safeEnd };
}

export function normalizeEvent(ev, stepMin) {
  const { laneType, laneId } = canonicalizeLane(ev);

  const { qStart, qEnd } = quantizeTimes(ev.start ?? ev.qStart, ev.end ?? ev.qEnd, stepMin);

  const type = ev.type || "unknown";

  // deterministische ID (überschreibt randomUUID-Probleme)
  // Wichtig: consumers stabil sortieren, sonst drift.
  const consumers = Array.isArray(ev.consumers) ? [...ev.consumers] : [];
  consumers.sort((a, b) => {
    const ka = `${a.orderId || ""}|${a.lineId || ""}|${a.qStart ?? a.start ?? 0}`;
    const kb = `${b.orderId || ""}|${b.lineId || ""}|${b.qStart ?? b.start ?? 0}`;
    return ka.localeCompare(kb);
  });

  const id = stableId(type, {
    laneType,
    laneId,
    qStart,
    qEnd,
    productId: ev.productId ?? ev.product ?? null,
    volumeL: ev.volumeL ?? ev.volume ?? null,
    lockKind: ev.lockKind ?? null,
    consumers: consumers.map(c => ({
      orderId: c.orderId ?? null,
      lineId: c.lineId ?? null,
      qStart: c.qStart ?? c.start ?? null,
      qEnd: c.qEnd ?? c.end ?? null,
      volumeL: c.volumeL ?? c.volume ?? null,
    })),
  });

  return {
    ...ev,
    id,
    laneType,
    laneId,

    // qTimes sind Gate-Source-of-Truth
    qStart,
    qEnd,

    // UI darf start/end anzeigen, aber wir setzen sie konsistent auf q
    start: qStart,
    end: qEnd,

    // Back-compat: viele UI-Teile filtern noch über "lane"
    lane: laneType === "LINE" ? laneId : laneId,

    type,
    consumers,
  };
}

export function sortCanonical(events) {
  return [...events].sort((a, b) => {
    const la = LANE_TYPE_ORDER[a.laneType] ?? 99;
    const lb = LANE_TYPE_ORDER[b.laneType] ?? 99;
    if (la !== lb) return la - lb;

    const ida = String(a.laneId);
    const idb = String(b.laneId);
    if (ida !== idb) return ida.localeCompare(idb);

    if (a.qStart !== b.qStart) return a.qStart - b.qStart;
    if (a.qEnd !== b.qEnd) return a.qEnd - b.qEnd;

    const pa = TYPE_PRIORITY[a.type] ?? 50;
    const pb = TYPE_PRIORITY[b.type] ?? 50;
    if (pa !== pb) return pa - pb;

    return String(a.id).localeCompare(String(b.id));
  });
}

export function indexByLane(events) {
  const map = new Map(); // key = `${laneType}:${laneId}` -> []
  for (const ev of events) {
    const key = `${ev.laneType}:${ev.laneId}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ev);
  }
  for (const [k, list] of map.entries()) {
    map.set(k, sortCanonical(list));
  }
  return map;
}

export function normalizeEvents(rawEvents, stepMin = 5) {
  const diagnostics = [];

  const arr = Array.isArray(rawEvents) ? rawEvents : [];
  const normalized = arr.map(ev => normalizeEvent(ev, stepMin));
  const sorted = sortCanonical(normalized);

  // Idempotenz-Check (optional als Diagnose – Test macht’s “hart”)
  // Wir prüfen hier nur grob: doppelte IDs => Bug.
  const seen = new Set();
  for (const ev of sorted) {
    if (seen.has(ev.id)) {
      diagnostics.push({
        code: "DUPLICATE_EVENT_ID",
        severity: "WARN",
        message: `Duplicate event id after normalize: ${ev.id}`,
        eventId: ev.id,
      });
    }
    seen.add(ev.id);
  }

  return {
    events: sorted,
    laneIndex: indexByLane(sorted),
    diagnostics,
  };
}
