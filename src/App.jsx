import React from "react";
import Timeline from "./components/Timeline";

export default function App() {
  return (
    <div className="p-6">
      <h1 className="text-green-400 text-4xl mb-4">RMS-Z</h1>

      {/* Zeitstrahl */}
      <Timeline />
    </div>
  );
}
