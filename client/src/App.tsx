import {
  PEER_COLORS,
  PROTOCOL_VERSION,
  REACTION_EMOJIS,
  encodeMessage,
  parseClientMessage,
} from "@protocol";

export default function App() {
  const smoke = parseClientMessage(encodeMessage({ t: "move", x: 0.5, y: 0.5, seq: 1 }));

  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>live-room — Phase 0 scaffold</h1>
      <p>
        protocol v{PROTOCOL_VERSION} · shared module wired:{" "}
        <strong>{String(smoke.ok)}</strong>
      </p>
      <p>
        palette:{" "}
        {PEER_COLORS.map((c) => (
          <span key={c} style={{ background: c, display: "inline-block", width: 18, height: 18, marginRight: 4 }} />
        ))}
      </p>
      <p>reactions: {REACTION_EMOJIS.join(" ")}</p>
    </main>
  );
}
