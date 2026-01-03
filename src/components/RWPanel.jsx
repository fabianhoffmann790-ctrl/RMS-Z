import React, { useMemo, useState } from "react";
import { reactors, productionLanes } from "../logic/timelineEngine";

function fmtTimeFrom6(min) {
  const base = 6 * 60; // 06:00
  const t = base + Math.round(min);
  const hh = Math.floor((t / 60) % 24);
  const mm = t % 60;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function getPos1Candidates(lineJobs, manualAssignments) {
  const assignedOrderIds = new Set(Object.values(manualAssignments || {}).map(a => a.orderId));

  // pro Linie den ersten Auftrag (orderIndex=1 oder isIstPos1)
  const byLine = {};
  for (const j of lineJobs || []) {
    const lineId = j.lineId ?? j.line;
    const orderIndex = j.orderIndex ?? j.order ?? 0;
    const isPos1 = Boolean(j.isIstPos1) || orderIndex === 1;

    if (!isPos1) continue;
    if (!lineId) continue;

    const orderId = j.orderId ?? j.id;
    if (!orderId) continue;
    if (assignedOrderIds.has(orderId)) continue;

    const entry = {
      orderId,
      lineId,
      orderIndex,
      productId: j.productId ?? j.product,
      volumeL: Number(j.volumeL ?? j.volume),
      meta: {
        customerOrderNo: j.customerOrderNo,
        batchNo: j.batchNo,
        chargeNo: j.chargeNo
      }
    };

    if (!byLine[lineId]) byLine[lineId] = entry;
    // falls es mehrere Pos1s gibt, nimm den kleinsten orderIndex
    else if ((entry.orderIndex ?? 999) < (byLine[lineId].orderIndex ?? 999)) byLine[lineId] = entry;
  }

  return Object.values(byLine)
    .filter(x => Number.isFinite(x.volumeL) && x.volumeL > 0)
    .sort((a, b) => a.lineId.localeCompare(b.lineId));
}

function getNextPlannedForRW(events, rwId, afterT = 0) {
  const list = (events || [])
    .filter(e => e.type === "rwBatch" && e.lane === rwId)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

  return list.find(e => (e.start ?? 0) >= afterT) || null;
}

function getCurrentLockedUntilForAssignment(asg) {
  // Pos1 startet bei t=0 -> Fill-Dauer = volume/30
  const fillEnd = (asg.volumeL || 0) / 30;
  return Math.max(0, fillEnd);
}

function StatusBadge({ status }) {
  const cls =
    status === "FREI"
      ? "bg-emerald-600/20 text-emerald-300 border-emerald-700"
      : status === "IST"
      ? "bg-orange-600/20 text-orange-300 border-orange-700"
      : "bg-sky-600/20 text-sky-300 border-sky-700";

  return (
    <span className={`px-2 py-0.5 rounded border text-xs ${cls}`}>
      {status}
    </span>
  );
}

function RWCard({
  rw,
  events,
  lineJobs,
  manualAssignments,
  setManualAssignments,
  setPlanDirty
}) {
  const [q, setQ] = useState("");

  const asg = manualAssignments?.[rw.name] || null;

  const candidates = useMemo(() => {
    const base = getPos1Candidates(lineJobs, manualAssignments);
    const qq = (q || "").trim().toLowerCase();
    if (!qq) return base;

    return base.filter(x => {
      const hay = `${x.lineId} ${x.orderId} ${x.productId}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [lineJobs, manualAssignments, q]);

  // Status + Anzeige
  let status = "FREI";
  let currentProduct = null;
  let lockedUntil = null;

  if (asg) {
    status = "IST";
    currentProduct = asg.productId;
    lockedUntil = getCurrentLockedUntilForAssignment(asg);
  } else {
    const next = getNextPlannedForRW(events, rw.name, 0);
    if (next) status = "GEPLANT";
  }

  const nextPlanned = getNextPlannedForRW(events, rw.name, lockedUntil ?? 0);

  function assign(order) {
    setManualAssignments(prev => {
      const copy = { ...(prev || {}) };
      copy[rw.name] = {
        orderId: order.orderId,
        productId: order.productId,
        volumeL: order.volumeL,
        meta: order.meta,
        mode: "IST",
        locked: true
      };
      return copy;
    });
    setPlanDirty(true);
  }

  function unassign() {
    if (!confirm(`IST-Belegung von ${rw.name} wirklich lösen?`)) return;
    setManualAssignments(prev => {
      const copy = { ...(prev || {}) };
      delete copy[rw.name];
      return copy;
    });
    setPlanDirty(true);
  }

  return (
    <div className="bg-gray-900/70 border border-gray-700 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">{rw.name}</div>
          <div className="text-xs opacity-70">
            {rw.min}–{rw.max} L
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-3">
        <div className="text-xs opacity-70 mb-1">Aktuelles Produkt</div>
        {asg ? (
          <div className="text-sm">
            <div className="font-semibold">{asg.productId}</div>
            <div className="text-xs opacity-75">
              Auftrag: {asg.orderId} · Volumen: {asg.volumeL} L
            </div>
            <div className="text-xs opacity-75">
              gesperrt bis: {fmtTimeFrom6(lockedUntil)}
            </div>

            <button
              onClick={unassign}
              className="mt-2 text-xs bg-red-600/70 hover:bg-red-600 px-2 py-1 rounded"
            >
              IST-Belegung lösen
            </button>
          </div>
        ) : (
          <div className="text-sm opacity-70">— frei —</div>
        )}
      </div>

      <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-3">
        <div className="text-xs opacity-70 mb-1">Nächstes geplantes Produkt</div>
        {nextPlanned ? (
          <div className="text-sm">
            <div className="font-semibold">{nextPlanned.productId}</div>
            <div className="text-xs opacity-75">
              Slot: {fmtTimeFrom6(nextPlanned.start)}–{fmtTimeFrom6(nextPlanned.end)}
            </div>
            <div className="text-xs opacity-75">Volumen: {Math.round(nextPlanned.volumeL)} L</div>
          </div>
        ) : (
          <div className="text-sm opacity-70">— nichts geplant —</div>
        )}
      </div>

      {!asg && (
        <div className="bg-gray-950/40 border border-emerald-900/40 rounded-lg p-3">
          <div className="text-xs opacity-70 mb-2">Pos1 zuweisen</div>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm"
            placeholder="Suche: Linie / OrderId / Produkt"
          />

          <div className="mt-2 max-h-40 overflow-auto border border-gray-800 rounded">
            {candidates.length === 0 ? (
              <div className="p-2 text-xs opacity-60">Keine gültigen Pos1-Treffer</div>
            ) : (
              candidates.map(c => (
                <button
                  key={c.orderId}
                  onClick={() => assign(c)}
                  className="w-full text-left px-2 py-2 hover:bg-gray-800 border-b border-gray-900 last:border-b-0"
                  title="Zuweisen"
                >
                  <div className="text-sm font-semibold">
                    {c.productId} · {c.volumeL} L
                  </div>
                  <div className="text-xs opacity-75">
                    {c.lineId} · Order: {c.orderId}
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="mt-2 text-[11px] opacity-60">
            Hinweis: Es passiert noch nichts am Zeitstrahl, bis du „Plan berechnen“ drückst.
          </div>
        </div>
      )}
    </div>
  );
}

export default function RWPanel({
  events,
  lineJobs,
  manualAssignments,
  setManualAssignments,
  setPlanDirty
}) {
  const rws = reactors.filter(r => productionLanes.includes(r.id));

  return (
    <div className="mt-4">
      <div className="flex items-end justify-between gap-3 mb-2">
        <h3 className="text-lg font-semibold">Rührwerke</h3>
        <div className="text-xs opacity-60">
          IST-Zuweisung nur Pos1 · pro RW genau 1 IST-Produkt
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rws.map(rw => (
          <RWCard
            key={rw.name}
            rw={rw}
            events={events}
            lineJobs={lineJobs}
            manualAssignments={manualAssignments}
            setManualAssignments={setManualAssignments}
            setPlanDirty={setPlanDirty}
          />
        ))}
      </div>
    </div>
  );
}
