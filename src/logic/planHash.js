// src/logic/planHash.js
import { fnv1a32 } from "./normalizeEvents";

export function computePlanHash(events) {
  const arr = Array.isArray(events) ? events : [];
  const payload = arr.map(ev => ({
    id: ev.id,
    laneType: ev.laneType,
    laneId: ev.laneId,
    qStart: ev.qStart,
    qEnd: ev.qEnd,
    type: ev.type,
    productId: ev.productId ?? ev.product ?? null,
    volumeL: ev.volumeL ?? ev.volume ?? null,
    lockKind: ev.lockKind ?? null,
    consumers: Array.isArray(ev.consumers)
      ? [...ev.consumers]
          .map(c => ({
            orderId: c.orderId ?? null,
            lineId: c.lineId ?? null,
            qStart: c.qStart ?? c.start ?? null,
            qEnd: c.qEnd ?? c.end ?? null,
            volumeL: c.volumeL ?? c.volume ?? null,
          }))
          .sort((a, b) => `${a.orderId}|${a.lineId}|${a.qStart}`.localeCompare(`${b.orderId}|${b.lineId}|${b.qStart}`))
      : [],
  }));

  const json = JSON.stringify(payload);
  return fnv1a32(json).toString(16).padStart(8, "0");
}
