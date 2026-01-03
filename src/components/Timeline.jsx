import React, { useMemo, useState } from "react";
import RWPanel from "./RWPanel";
import TimeAxis from "./TimeAxis";
import LaneRow from "./LaneRow";

import { calculatePlanV02 } from "../logic/planCalculator";
import {
  productionLanes,
  fillingLanes,
  ibcLane,
  computeTimelineBounds
} from "../logic/timelineEngine";

// Fallback-UUID (falls crypto.randomUUID mal nicht verfügbar ist)
function uid() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

// sorgt dafür, dass React-Keys (LaneRow) niemals doppelt sind
function ensureUniqueEventIds(events) {
  const seen = new Map();
  return (events || []).map((ev, idx) => {
    const base =
      ev?.id ??
      `${ev?.type || "ev"}_${ev?.lane || "lane"}_${ev?.start ?? "s"}_${ev?.end ?? "e"}_${idx}`;

    const n = seen.get(base) || 0;
    seen.set(base, n + 1);

    if (n === 0) return ev;
    return { ...ev, id: `${base}__dup${n}` };
  });
}

export default function Timeline() {
  // Orders (Input)
  const [lineJobs, setLineJobs] = useState([]);

  // IST-Zuweisungen: rwId -> { orderId, productId, volumeL, mode:"IST", locked:true }
  const [manualAssignments, setManualAssignments] = useState({});

  // Plan-Events (Timeline)
  const [events, setEvents] = useState([]);

  // UI
  const [planDirty, setPlanDirty] = useState(true);
  const [scale, setScale] = useState(2); // px/min

  // Inputfelder
  const [selectedLine, setSelectedLine] = useState(fillingLanes[0]);
  const [productInput, setProductInput] = useState("P1");
  const [volumeInput, setVolumeInput] = useState(10000);
  const [isIstPos1, setIsIstPos1] = useState(false);

  // Bounds + Render-Events
  const renderEvents = useMemo(() => ensureUniqueEventIds(events), [events]);
  const bounds = useMemo(() => computeTimelineBounds(renderEvents), [renderEvents]);

  const totalWidth = Math.max(900, (bounds.max - bounds.min) * scale + 200);
  const startOffset = bounds.min;

  // ---- Order Handling ----
  function recomputeOrderIndexPerLine(jobs) {
    const byLine = new Map();
    for (const j of jobs) {
      const lineId = j.lineId ?? j.line ?? "";
      if (!byLine.has(lineId)) byLine.set(lineId, []);
      byLine.get(lineId).push(j);
    }
    for (const [lineId, arr] of byLine.entries()) {
      arr
        .sort((a, b) => (a.orderIndex ?? a.order ?? 0) - (b.orderIndex ?? b.order ?? 0))
        .forEach((j, i) => {
          j.orderIndex = i + 1;
          j.lineId = lineId;
        });
    }
    return jobs;
  }

  function handleAddLineJob() {
    const v = Number(volumeInput);
    if (!selectedLine || !productInput || !Number.isFinite(v) || v <= 0) return;

    // orderIndex = nächster Platz auf Linie
    const existing = lineJobs.filter(j => (j.lineId ?? j.line) === selectedLine);
    const nextIndex =
      (existing.length ? Math.max(...existing.map(j => j.orderIndex ?? j.order ?? 0)) : 0) + 1;

    const newJob = {
      orderId: uid(),
      lineId: selectedLine,
      orderIndex: nextIndex,
      productId: String(productInput).trim(),
      volumeL: v,
      isIstPos1: !!isIstPos1
    };

    const next = recomputeOrderIndexPerLine([...lineJobs, newJob]);
    setLineJobs(next);
    setPlanDirty(true);
  }

  function handleRemoveJob(orderId) {
    const next = recomputeOrderIndexPerLine(lineJobs.filter(j => j.orderId !== orderId));

    // wenn IST-Zuweisung auf diesen Auftrag zeigt, entfernen
    const maNext = { ...manualAssignments };
    for (const [rwId, a] of Object.entries(maNext)) {
      if (a?.orderId === orderId) delete maNext[rwId];
    }

    setManualAssignments(maNext);
    setLineJobs(next);
    setPlanDirty(true);
  }

  function handleClearAll() {
    setLineJobs([]);
    setManualAssignments({});
    setEvents([]);
    setPlanDirty(true);
  }

  // ---- Planning ----
  function handleCalculatePlan(e) {
    // sehr wichtig: falls Button doch irgendwo im form landet -> kein Submit
    if (e?.preventDefault) e.preventDefault();

    const result = calculatePlanV02({
      lineJobs,
      manualAssignments
    });

    const nextEvents = ensureUniqueEventIds(result?.events || []);
    setEvents(nextEvents);
    setPlanDirty(false);
  }

  // ---- UI: Orderliste nach Linien ----
  const jobsByLine = useMemo(() => {
    const map = new Map();
    for (const ln of fillingLanes) map.set(ln, []);
    for (const j of lineJobs) {
      const ln = j.lineId ?? j.line;
      if (!map.has(ln)) map.set(ln, []);
      map.get(ln).push(j);
    }
    for (const [ln, arr] of map.entries()) {
      arr.sort((a, b) => (a.orderIndex ?? a.order ?? 0) - (b.orderIndex ?? b.order ?? 0));
      map.set(ln, arr);
    }
    return map;
  }, [lineJobs]);

  return (
    <div className="p-4">
      <div className="text-2xl font-semibold text-emerald-500">RMS-Z</div>
      <div className="text-sm text-slate-400">RMS-Z Planer v0.2</div>

      {/* Top Actions */}
      <div className="mt-3 flex items-center gap-2">
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="px-2 py-1 rounded bg-slate-800 text-slate-200 border border-slate-700"
              onClick={() => setScale(s => Math.max(0.5, s - 0.5))}
              title="Zoom -"
            >
              -
            </button>
            <div className="text-xs text-slate-300 px-2">{scale} px/min</div>
            <button
              type="button"
              className="px-2 py-1 rounded bg-slate-800 text-slate-200 border border-slate-700"
              onClick={() => setScale(s => Math.min(10, s + 0.5))}
              title="Zoom +"
            >
              +
            </button>
          </div>

          <button
            type="button"
            onClick={handleCalculatePlan}
            disabled={lineJobs.length === 0}
            className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-40"
          >
            Plan berechnen
          </button>

          <button
            type="button"
            onClick={handleClearAll}
            className="px-3 py-2 rounded bg-red-600 text-white"
          >
            Aufträge löschen
          </button>
        </div>
      </div>

      {/* Auftrag anlegen */}
      <div className="mt-3 bg-slate-900/40 border border-slate-700 rounded p-3">
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-2">
            <label className="text-xs text-slate-300">Linie</label>
            <select
              className="w-full mt-1 bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1"
              value={selectedLine}
              onChange={e => setSelectedLine(e.target.value)}
            >
              {fillingLanes.map(l => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          <div className="col-span-4">
            <label className="text-xs text-slate-300">Produkt</label>
            <input
              className="w-full mt-1 bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1"
              value={productInput}
              onChange={e => setProductInput(e.target.value)}
              placeholder="P1"
            />
          </div>

          <div className="col-span-3">
            <label className="text-xs text-slate-300">Menge (L)</label>
            <input
              type="number"
              className="w-full mt-1 bg-slate-800 border border-slate-700 text-slate-100 rounded px-2 py-1"
              value={volumeInput}
              onChange={e => setVolumeInput(e.target.value)}
              min={1}
            />
          </div>

          <div className="col-span-2 flex items-center gap-2">
            <input
              id="istpos1"
              type="checkbox"
              checked={isIstPos1}
              onChange={e => setIsIstPos1(e.target.checked)}
            />
            <label htmlFor="istpos1" className="text-xs text-slate-300">
              Ist-Pos1 (Restauftrag, Start t=0)
            </label>
          </div>

          <div className="col-span-1">
            <button
              type="button"
              onClick={handleAddLineJob}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white rounded px-2 py-2"
            >
              Auftrag hinzufügen
            </button>
          </div>
        </div>
      </div>

      {/* Auftragsliste */}
      <div className="mt-3 bg-slate-900/40 border border-slate-700 rounded p-3">
        <div className="text-sm font-semibold text-slate-200 mb-2">
          Geplante Abfüllaufträge (Input)
        </div>

        <div className="grid grid-cols-5 gap-2">
          {fillingLanes.map(ln => {
            const arr = jobsByLine.get(ln) || [];
            return (
              <div key={ln} className="bg-slate-800/60 border border-slate-700 rounded p-2">
                <div className="text-xs text-slate-300 mb-1">{ln}</div>

                {arr.length === 0 ? (
                  <div className="text-xs text-slate-500">— keine Aufträge —</div>
                ) : (
                  <div className="space-y-1">
                    {arr.map(j => (
                      <div
                        key={j.orderId}
                        className="flex items-center justify-between gap-2 bg-slate-900/40 border border-slate-700 rounded px-2 py-1"
                      >
                        <div className="text-xs text-slate-200">
                          <span className="text-slate-400">#{j.orderIndex}</span>{" "}
                          <b>{j.productId}</b> ({j.volumeL} L)
                          {j.isIstPos1 ? (
                            <span className="ml-2 text-[10px] px-1 py-[1px] rounded bg-orange-600/30 border border-orange-600 text-orange-200">
                              Pos1
                            </span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveJob(j.orderId)}
                          className="text-xs px-2 py-1 rounded bg-red-700 text-white"
                          title="Auftrag entfernen"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {planDirty ? (
          <div className="mt-2 text-xs text-amber-300">
            Hinweis: Änderungen vorhanden – bitte „Plan berechnen“ drücken.
          </div>
        ) : (
          <div className="mt-2 text-xs text-slate-500">
            Plan ist aktuell.
          </div>
        )}
      </div>

      {/* RW-Kachelpanel */}
      <RWPanel
        events={renderEvents}
        lineJobs={lineJobs}
        manualAssignments={manualAssignments}
        setManualAssignments={setManualAssignments}
        planDirty={planDirty}
        setPlanDirty={setPlanDirty}
      />

      {/* ZEITSTRAHL */}
      <div className="mt-4 bg-slate-900/40 border border-slate-700 rounded p-3 overflow-x-auto">
        <div style={{ width: totalWidth }}>
          <TimeAxis start={bounds.min} end={bounds.max} scale={scale} />

          <div className="mt-2 text-sm font-semibold text-slate-200">Rührwerke</div>
          {productionLanes.map(lane => (
            <LaneRow
              key={lane}
              lane={lane}
              events={renderEvents}
              scale={scale}
              startOffset={startOffset}
            />
          ))}

          <div className="mt-4 text-sm font-semibold text-slate-200">IBC</div>
          <LaneRow
            key={ibcLane}
            lane={ibcLane}
            events={renderEvents}
            scale={scale}
            startOffset={startOffset}
          />

          <div className="mt-4 text-sm font-semibold text-slate-200">Abfülllinien</div>
          {fillingLanes.map(lane => (
            <LaneRow
              key={lane}
              lane={lane}
              events={renderEvents}
              scale={scale}
              startOffset={startOffset}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
