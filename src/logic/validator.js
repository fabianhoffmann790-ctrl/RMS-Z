// src/logic/validator.js

export function validateCanonicalPlan({ events, stepMin = 5 }) {
  const errors = [];
  const arr = Array.isArray(events) ? events : [];

  // Basic invariants
  for (const ev of arr) {
    if (!ev.laneType || !ev.laneId) {
      errors.push({
        code: "LANE_NOT_CANONICAL",
        message: `Missing laneType/laneId on event ${ev.id}`,
        eventId: ev.id,
      });
    }

    if (!Number.isFinite(ev.qStart) || !Number.isFinite(ev.qEnd)) {
      errors.push({
        code: "QTIME_MISSING",
        message: `Missing qStart/qEnd on event ${ev.id}`,
        eventId: ev.id,
      });
      continue;
    }

    if (ev.qStart % stepMin !== 0 || ev.qEnd % stepMin !== 0) {
      errors.push({
        code: "QTIME_NOT_QUANTIZED",
        message: `qTimes not multiple of stepMin on ${ev.id}`,
        eventId: ev.id,
      });
    }

    if (ev.qEnd < ev.qStart + stepMin) {
      errors.push({
        code: "QTIME_INVALID_RANGE",
        message: `qEnd < qStart+stepMin on ${ev.id}`,
        eventId: ev.id,
      });
    }

    // Type ↔ laneType invariants
    if (ev.type === "lineFill" && ev.laneType !== "LINE") {
      errors.push({
        code: "TYPE_LANE_MISMATCH",
        message: `lineFill must be laneType LINE: ${ev.id}`,
        eventId: ev.id,
      });
    }
    if (ev.type === "rwBatch" && ev.laneType !== "RW") {
      errors.push({
        code: "TYPE_LANE_MISMATCH",
        message: `rwBatch must be laneType RW: ${ev.id}`,
        eventId: ev.id,
      });
    }
    if (ev.type === "ibcBatch" && ev.laneType !== "IBC") {
      errors.push({
        code: "TYPE_LANE_MISMATCH",
        message: `ibcBatch must be laneType IBC: ${ev.id}`,
        eventId: ev.id,
      });
    }
  }

  // Overlap check per lane (qTimes)
  const byLane = new Map();
  for (const ev of arr) {
    const key = `${ev.laneType}:${ev.laneId}`;
    if (!byLane.has(key)) byLane.set(key, []);
    byLane.get(key).push(ev);
  }

  for (const [key, list] of byLane.entries()) {
    const sorted = [...list].sort((a, b) => a.qStart - b.qStart || a.qEnd - b.qEnd || String(a.id).localeCompare(String(b.id)));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const overlap = cur.qStart < prev.qEnd; // strict overlap
      if (overlap) {
        errors.push({
          code: "LANE_OVERLAP",
          message: `Overlap on lane ${key}: ${prev.id} (${prev.qStart}-${prev.qEnd}) overlaps ${cur.id} (${cur.qStart}-${cur.qEnd})`,
          laneKey: key,
          eventId: cur.id,
          blockerId: prev.id,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
