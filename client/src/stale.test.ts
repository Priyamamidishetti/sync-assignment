import { describe, expect, it, vi } from "vitest";
import { peerOpacity, RoomSession, type RemotePeer } from "./connection";

describe("stale peer fade & removal (Phase 6 / FR-11)", () => {
  it("peerOpacity returns 1.0 for active peers under 10s", () => {
    const peer: RemotePeer = {
      clientId: "p1",
      name: "Alice",
      color: 0,
      cursor: { x: 0.5, y: 0.5, seq: 1, at: 1000 },
      lastSeq: 1,
      lastSeenAt: 1000,
    };
    expect(peerOpacity(peer, 1000)).toBe(1);
    expect(peerOpacity(peer, 6000)).toBe(1);
    expect(peerOpacity(peer, 10999)).toBe(1);
  });

  it("peerOpacity decays linearly between 10s and 15s to 0", () => {
    const peer: RemotePeer = {
      clientId: "p1",
      name: "Alice",
      color: 0,
      cursor: { x: 0.5, y: 0.5, seq: 1, at: 1000 },
      lastSeq: 1,
      lastSeenAt: 1000,
    };
    // At age 12.5s (now = 13500), opacity is halfway: 0.5
    expect(peerOpacity(peer, 13500)).toBeCloseTo(0.5, 4);
    // At age 14s (now = 15000), opacity is 1 - 4/5 = 0.2
    expect(peerOpacity(peer, 15000)).toBeCloseTo(0.2, 4);
    // At age 15s and beyond, opacity is 0
    expect(peerOpacity(peer, 16000)).toBe(0);
    expect(peerOpacity(peer, 20000)).toBe(0);
  });

  it("sweepStalePeers prunes peers inactive for >= 15s and emits peers event", () => {
    let now = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);

    const events: string[] = [];
    const session = new RoomSession({
      url: "ws://dummy",
      roomId: "r",
      clientId: "me",
      onEvent: (e) => events.push(e.type),
    });

    // Simulate inbound welcome at now = 1000
    const welcome = JSON.stringify({
      t: "welcome",
      serverTime: Date.now(),
      you: { clientId: "me", name: "Me", color: 0 },
      peers: [
        { clientId: "active", name: "Active", color: 1, x: 0.1, y: 0.1, seq: 1 },
        { clientId: "stale", name: "Stale", color: 2, x: 0.2, y: 0.2, seq: 1 },
      ],
    });
    (session as unknown as { onInbound: (s: string) => void }).onInbound(welcome);

    expect(session.peerList().length).toBe(2);

    // Keep "active" updated at now = 10,000
    now = 10_000;
    const cursorMsg = JSON.stringify({
      t: "cursor",
      from: "active",
      x: 0.3,
      y: 0.3,
      seq: 2,
      ts: Date.now(),
    });
    (session as unknown as { onInbound: (s: string) => void }).onInbound(cursorMsg);

    // At now = 17,000: stale age = 16s (>= 15s), active age = 7s (< 15s)
    now = 17_000;
    events.length = 0;
    const pruned = session.sweepStalePeers(now);
    expect(pruned).toBe(true);

    const remaining = session.peerList();
    expect(remaining.length).toBe(1);
    expect(remaining[0].clientId).toBe("active");
    expect(events).toContain("peers");

    nowSpy.mockRestore();
    session.close();
  });
});
