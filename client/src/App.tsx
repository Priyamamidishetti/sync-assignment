import { useEffect, useMemo, useRef, useState } from "react";
import { PEER_COLORS, REACTION_EMOJIS, type PeerInfo, type ReactionEmoji } from "@protocol";
import { CursorCanvas } from "./render";
import {
  peerOpacity,
  RoomSession,
  defaultWsUrl,
  type ConnectionState,
  type InterpDebugEntry,
  type RemotePeer,
} from "./connection";
import { DEFAULT_INTERPOLATION } from "./interpolation";
import { loadClientId, loadName, saveName } from "./identity";

interface UiState {
  state: ConnectionState;
  attempt: number;
  peers: RemotePeer[];
  you: PeerInfo | null;
  rttMs: number | null;
}

interface ChatMessage {
  readonly id: string;
  readonly from: string;
  readonly name: string;
  readonly color: number;
  readonly text: string;
  readonly ts: number;
  readonly isSelf: boolean;
}

const STATE_META: Record<ConnectionState, { color: string; label: string }> = {
  connecting: { color: "#f4a259", label: "connecting" },
  online: { color: "#8ac926", label: "online" },
  reconnecting: { color: "#e05680", label: "reconnecting" },
};

const chrome: React.CSSProperties = {
  background: "rgba(18,18,24,0.85)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  color: "#e8e8ee",
  fontFamily: "system-ui, sans-serif",
  backdropFilter: "blur(6px)",
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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const roomId = useMemo(
    () => new URLSearchParams(window.location.search).get("room") ?? "lobby",
    [],
  );
  const snapMode = useMemo(
    () => new URLSearchParams(window.location.search).get("snap") === "1",
    [],
  );
  const [nameDraft, setNameDraft] = useState(() => loadName() ?? "");
  const [appliedName, setAppliedName] = useState<string | undefined>(() => loadName());
  const [emoji, setEmoji] = useState<ReactionEmoji>("🔥");
  const emojiRef = useRef<ReactionEmoji>("🔥"); // read by the renderer without effect churn
  const [ui, setUi] = useState<UiState>({
    state: "connecting",
    attempt: 0,
    peers: [],
    you: null,
    rttMs: null,
  });
  const [interpRows, setInterpRows] = useState<InterpDebugEntry[]>([]);

  // Chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const selectEmoji = (e: ReactionEmoji) => {
    emojiRef.current = e;
    setEmoji(e);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let renderer: CursorCanvas | null = null; // assigned below; events fire only after start()

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
          renderer?.spawnReaction(event.emoji, event.x, event.y);
          return;
        }
        if (event.type === "chat") {
          setChatMessages((prev) => [
            ...prev,
            {
              id: `${event.from}-${event.seq}-${event.ts}`,
              from: event.from,
              name: event.name,
              color: event.color,
              text: event.text,
              ts: event.ts,
              isSelf: false,
            },
          ]);
          setChatOpen((open) => {
            if (!open) setUnreadCount((c) => c + 1);
            return open;
          });
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

    sessionRef.current = session;
    renderer = new CursorCanvas(canvas, session, () => emojiRef.current);
    session.start();
    renderer.start();

    let debugInterval: ReturnType<typeof setInterval> | null = null;
    if (import.meta.env.DEV) {
      debugInterval = setInterval(() => setInterpRows(session.interpolationDebug()), 300);
    }

    return () => {
      sessionRef.current = null;
      if (debugInterval !== null) clearInterval(debugInterval);
      renderer?.stop();
      session.close();
    };
  }, [appliedName, roomId, snapMode]);

  // Number keys 1–8 switch the reaction emoji (never while typing in inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < REACTION_EMOJIS.length) {
        selectEmoji(REACTION_EMOJIS[idx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-scroll chat to latest message
  useEffect(() => {
    if (chatOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages, chatOpen]);

  const commitName = () => {
    const trimmed = nameDraft.trim().slice(0, 24);
    if (trimmed === (appliedName ?? "")) return;
    saveName(trimmed);
    setAppliedName(trimmed.length > 0 ? trimmed : undefined);
  };

  const handleSendChat = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = chatDraft.trim();
    if (text.length === 0 || !sessionRef.current) return;
    sessionRef.current.sendChat(text);
    // Instant local echo
    setChatMessages((prev) => [
      ...prev,
      {
        id: `self-${Date.now()}-${Math.random()}`,
        from: loadClientId(),
        name: appliedName ?? ui.you?.name ?? "you",
        color: ui.you?.color ?? 0,
        text,
        ts: Date.now(),
        isSelf: true,
      },
    ]);
    setChatDraft("");
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
          touchAction: "none", // taps react; no scroll/zoom gestures
        }}
      />

      <header
        style={{
          ...chrome,
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          gap: 16,
          alignItems: "center",
          padding: "10px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 0,
          zIndex: 10,
        }}
      >
        <strong style={{ fontSize: 14 }}>live-room</strong>
        <span style={{ fontSize: 12, opacity: 0.7 }}>room: {roomId}</span>
        {snapMode && (
          <span style={{ fontSize: 11, background: "#5b8ee6", color: "#0d0d12", borderRadius: 6, padding: "2px 8px" }}>
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

        {/* Chat Drawer Toggle Button */}
        <button
          onClick={() => {
            setChatOpen((open) => !open);
            if (!chatOpen) setUnreadCount(0);
          }}
          style={{
            background: chatOpen ? "rgba(91,142,230,0.25)" : "rgba(255,255,255,0.08)",
            border: chatOpen ? "1px solid #5b8ee6" : "1px solid rgba(255,255,255,0.15)",
            color: "#fff",
            borderRadius: 6,
            padding: "3px 10px",
            fontSize: 12,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>💬 Chat</span>
          {unreadCount > 0 && (
            <span
              style={{
                background: "#e05680",
                color: "#fff",
                borderRadius: 999,
                padding: "1px 6px",
                fontSize: 10,
                fontWeight: "bold",
              }}
            >
              {unreadCount}
            </span>
          )}
        </button>

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

      {/* Presence list (FR-10): color dots + names, live on "peers" events. */}
      <aside
        style={{
          ...chrome,
          position: "fixed",
          top: 56,
          right: 12,
          padding: "10px 14px",
          fontSize: 12,
          zIndex: 10,
          minWidth: 130,
        }}
      >
        <div style={{ opacity: 0.55, fontSize: 11, marginBottom: 6 }}>participants</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, display: "inline-block", background: ui.you ? PEER_COLORS[ui.you.color] : "#888" }} />
          <span>{ui.you ? `${ui.you.name} (you)` : "you"}</span>
        </div>
        {ui.peers.map((p) => {
          const opacity = peerOpacity(p);
          return (
            <div
              key={p.clientId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 0",
                opacity: Math.max(0.25, opacity),
                transition: "opacity 0.3s ease",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  display: "inline-block",
                  background: PEER_COLORS[p.color] ?? "#888",
                }}
              />
              <span>{p.name}{opacity < 1 ? " (idle)" : ""}</span>
            </div>
          );
        })}
      </aside>

      {/* Collapsible Chat Drawer */}
      {chatOpen && (
        <div
          style={{
            ...chrome,
            position: "fixed",
            bottom: 60,
            right: 12,
            width: 300,
            height: 380,
            display: "flex",
            flexDirection: "column",
            zIndex: 20,
            boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
            border: "1px solid rgba(255,255,255,0.14)",
          }}
        >
          {/* Drawer Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>💬 Room Chat</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}>#{roomId}</span>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              style={{
                background: "transparent",
                border: "none",
                color: "#aaa",
                cursor: "pointer",
                fontSize: 15,
                lineHeight: 1,
                padding: 2,
              }}
              title="Close chat"
            >
              ✕
            </button>
          </div>

          {/* Messages Body */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {chatMessages.length === 0 && (
              <div style={{ opacity: 0.45, fontSize: 12, textAlign: "center", marginTop: 70 }}>
                No messages yet.<br />Say hello to the room! 👋
              </div>
            )}
            {chatMessages.map((m) => (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: m.isSelf ? "flex-end" : "flex-start",
                  gap: 2,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, opacity: 0.7 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: PEER_COLORS[m.color] ?? "#888",
                      display: "inline-block",
                    }}
                  />
                  <span>{m.isSelf ? "you" : m.name}</span>
                  <span>·</span>
                  <span>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div
                  style={{
                    background: m.isSelf ? "rgba(91,142,230,0.3)" : "rgba(255,255,255,0.07)",
                    border: m.isSelf ? "1px solid rgba(91,142,230,0.4)" : "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    fontSize: 12,
                    lineHeight: 1.4,
                    maxWidth: "85%",
                    wordBreak: "break-word",
                  }}
                >
                  {m.text}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Chat Input Bar */}
          <form
            onSubmit={handleSendChat}
            style={{
              padding: "8px 10px",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              gap: 6,
            }}
          >
            <input
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              placeholder="Type a message..."
              maxLength={300}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.15)",
                color: "#fff",
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={chatDraft.trim().length === 0}
              style={{
                background: chatDraft.trim().length > 0 ? "#5b8ee6" : "rgba(255,255,255,0.08)",
                color: chatDraft.trim().length > 0 ? "#fff" : "rgba(255,255,255,0.4)",
                border: "none",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: chatDraft.trim().length > 0 ? "pointer" : "default",
                transition: "background 0.15s ease",
              }}
            >
              Send
            </button>
          </form>
        </div>
      )}

      {/* Emoji picker: DOM above the canvas — its clicks never spawn reactions. */}
      <div
        style={{
          ...chrome,
          position: "fixed",
          bottom: 12,
          right: 12,
          display: "flex",
          gap: 4,
          padding: "6px 8px",
          zIndex: 10,
        }}
      >
        {REACTION_EMOJIS.map((e, i) => (
          <button
            key={e}
            onClick={() => selectEmoji(e)}
            title={`key ${i + 1}`}
            style={{
              width: 36,
              height: 36,
              fontSize: 19,
              lineHeight: 1,
              cursor: "pointer",
              borderRadius: 8,
              border: e === emoji ? "1px solid #5b8ee6" : "1px solid transparent",
              background: e === emoji ? "rgba(91,142,230,0.25)" : "transparent",
              transform: e === emoji ? "scale(1.08)" : "none",
            }}
          >
            {e}
          </button>
        ))}
      </div>

      {import.meta.env.DEV && (
        <div
          style={{
            ...chrome,
            position: "fixed",
            bottom: 12,
            left: 12,
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            lineHeight: 1.6,
            color: "#cfe3cf",
            padding: "8px 12px",
            pointerEvents: "none",
          }}
        >
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
