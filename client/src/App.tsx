import { useEffect, useMemo, useRef, useState } from "react";
import type { PeerInfo } from "@protocol";
import { CursorCanvas } from "./render";
import { RoomSession, defaultWsUrl, type ConnectionState, type InterpDebugEntry, type RemotePeer } from "./connection";
import { DEFAULT_INTERPOLATION } from "./interpolation";
import { loadClientId, loadName, saveName } from "./identity";

interface UiState {
  state: ConnectionState;
  attempt: number;
  peers: RemotePeer[];
  you: PeerInfo | null;
  rttMs: number | null;
}

const STATE_META: Record<ConnectionState, { color: string; label: string }> = {
  connecting: { color: "#f4a259", label: "connecting" },
  online: { color: "#8ac926", label: "online" },
  reconnecting: { color: "#e05680", label: "reconnecting" },
};

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#fff",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 12,
  width: 120,
};

const panelStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 12,
  left: 12,
  zIndex: 10,
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  lineHeight: 1.6,
  color: "#cfe3cf",
  background: "rgba(18,18,24,0.85)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: "8px 12px",
  pointerEvents: "none",
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roomId = useMemo(
    () => new URLSearchParams(window.location.search).get("room") ?? "lobby",
    [],
  );
  // A/B demo switch: snapping (Phase 3 behavior) vs interpolation (Phase 4).
  const snapMode = useMemo(
    () => new URLSearchParams(window.location.search).get("snap") === "1",
    [],
  );
  const [nameDraft, setNameDraft] = useState(() => loadName() ?? "");
  const [appliedName, setAppliedName] = useState<string | undefined>(() => loadName());
  const [ui, setUi] = useState<UiState>({
    state: "connecting",
    attempt: 0,
    peers: [],
    you: null,
    rttMs: null,
  });
  const [interpRows, setInterpRows] = useState<InterpDebugEntry[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const session = new RoomSession({
      url: defaultWsUrl(),
      roomId,
      clientId: loadClientId(),
      name: appliedName,
      debugRateLog: import.meta.env.DEV,
      interpolation: snapMode
        ? { renderDelayMs: 0, extrapolationCapMs: 0, recoveryMs: 0 }
        : undefined,
      onEvent: (event) => {
        if (event.type === "reaction") {
          console.log("[live-room] reaction (rendered in Phase 5):", event);
          return;
        }
        setUi((prev) => {
          switch (event.type) {
            case "state":
              return { ...prev, state: event.state, attempt: event.attempt };
            case "ready":
              return { ...prev, you: event.you };
            case "peers":
              return { ...prev, peers: session.peerList() };
            case "stats":
              return { ...prev, rttMs: event.rttMs };
            default:
              return prev;
          }
        });
      },
    });

    const renderer = new CursorCanvas(canvas, session);
    session.start();
    renderer.start();

    // Dev-only interpolation inspector (raw track state; the recovery
    // filter is never touched by polling).
    let debugInterval: ReturnType<typeof setInterval> | null = null;
    if (import.meta.env.DEV) {
      debugInterval = setInterval(() => setInterpRows(session.interpolationDebug()), 300);
    }

    return () => {
      if (debugInterval !== null) clearInterval(debugInterval);
      renderer.stop();
      session.close();
    };
  }, [appliedName, roomId, snapMode]);

  const commitName = () => {
    const trimmed = nameDraft.trim().slice(0, 24);
    if (trimmed === (appliedName ?? "")) return;
    saveName(trimmed);
    setAppliedName(trimmed.length > 0 ? trimmed : undefined);
  };

  const participants = ui.peers.length + 1;
  const meta = STATE_META[ui.state];

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          display: "block",
          cursor: "none",
        }}
      />
      <header
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          gap: 16,
          alignItems: "center",
          padding: "10px 16px",
          background: "rgba(18,18,24,0.85)",
          backdropFilter: "blur(6px)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          fontFamily: "system-ui, sans-serif",
          color: "#e8e8ee",
          zIndex: 10,
        }}
      >
        <strong style={{ fontSize: 14 }}>live-room</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>room: {roomId}</span>
        {snapMode && (
          <span
            style={{ fontSize: 11, background: "#5b8ee6", color: "#0d0d12", borderRadius: 6, padding: "2px 8px" }}
          >
            snap mode (no interpolation)
          </span>
        )}
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          name
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
            }}
            placeholder="Guest"
            maxLength={24}
            style={inputStyle}
          />
        </label>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginLeft: "auto" }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: meta.color, display: "inline-block" }} />
          {meta.label}
          {ui.state === "reconnecting" && ui.attempt > 1 ? ` (attempt ${ui.attempt})` : ""}
        </span>
        <span style={{ fontSize: 12 }}>
          {participants} {participants === 1 ? "participant" : "participants"}
        </span>
        {ui.rttMs !== null && (
          <span style={{ fontSize: 12, opacity: 0.7 }}>{Math.round(ui.rttMs)} ms</span>
        )}
      </header>

      {import.meta.env.DEV && (
        <div style={panelStyle}>
          <div style={{ color: "#9fd0ff" }}>
            interp ·{" "}
            {snapMode
              ? "disabled (?snap=1)"
              : `delay ${DEFAULT_INTERPOLATION.renderDelayMs}ms · cap ${DEFAULT_INTERPOLATION.extrapolationCapMs}ms · recovery ${DEFAULT_INTERPOLATION.recoveryMs}ms`}
          </div>
          {interpRows.length === 0 && <div>no remote samples yet</div>}
          {interpRows.map((r) => (
            <div key={r.clientId}>
              {r.name}: {r.mode} · depth={r.depth} · beyond={Math.round(r.beyondMs)}ms · rate={r.ratePerSec}/s
            </div>
          ))}
        </div>
      )}
    </>
  );
}
