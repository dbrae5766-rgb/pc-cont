import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CHANNEL_NAME = "remotedesk-signal";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  ],
};

const COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#3b82f6","#a855f7","#ffffff","#000000"];
const WIDTHS = [2, 4, 8, 16];

export default function App() {
  const [status, setStatus]             = useState("idle");
  const [error, setError]               = useState(null);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [resolution, setResolution]     = useState({ w: 0, h: 0 });
  const [fps, setFps]                   = useState(0);
  const [remoteCursor, setRemoteCursor] = useState({ x: -100, y: -100, sw: 1920, sh: 1080 });

  // Drawing state
  const [drawMode, setDrawMode]   = useState(false);
  const [drawColor, setDrawColor] = useState("#ef4444");
  const [drawWidth, setDrawWidth] = useState(4);
  const isDrawing                 = useRef(false);

  const videoRef       = useRef(null);
  const pcRef          = useRef(null);
  const channelRef     = useRef(null);
  const dataChannelRef = useRef(null);
  const supabaseRef    = useRef(null);
  const fpsCounterRef  = useRef({ frames: 0, last: Date.now() });
  const containerRef   = useRef(null);

  // ── Signaling ─────────────────────────────────────────────────────────
  const setupSignaling = useCallback(async () => {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supabaseRef.current = supabase;
    const channel = supabase.channel(CHANNEL_NAME, { config: { broadcast: { self: false } } });
    channelRef.current = channel;
    channel.on("broadcast", { event: "signal" }, async ({ payload }) => { await handleSignal(payload); });
    await channel.subscribe();
  }, []);

  const broadcast = useCallback(async (payload) => {
    if (channelRef.current)
      await channelRef.current.send({ type: "broadcast", event: "signal", payload });
  }, []);

  const handleSignal = useCallback(async (data) => {
    if (data.type === "cursor-pos") {
      setRemoteCursor({ x: data.x, y: data.y, sw: data.sw, sh: data.sh });
      return;
    }
    const pc = pcRef.current;
    if (!pc) return;
    if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
    } else if (data.type === "ice-candidate" && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data)); } catch {}
    } else if (data.type === "agent-ready") {
      await initiateOffer();
    }
  }, []);

  const initiateOffer = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    await broadcast({ type: "offer", sdp: offer.sdp });
  }, [broadcast]);

  const connect = useCallback(async () => {
    try {
      setStatus("connecting"); setError(null);
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;
      const dc = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
      dataChannelRef.current = dc;
      pc.ontrack = (event) => {
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
          setStatus("connected");
          const s = event.streams[0].getVideoTracks()[0].getSettings();
          setResolution({ w: s.width || 0, h: s.height || 0 });
        }
      };
      pc.onicecandidate = async (e) => {
        if (e.candidate) await broadcast({ type: "ice-candidate", candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
      };
      pc.onconnectionstatechange = () => {
        if (["failed","disconnected"].includes(pc.connectionState)) { setStatus("error"); setError("Connection lost."); }
      };
      await setupSignaling();
      await broadcast({ type: "browser-connected" });
      setTimeout(async () => { if (status !== "connected") await initiateOffer(); }, 3000);
    } catch (e) { setStatus("error"); setError(e.message); }
  }, [setupSignaling, broadcast, initiateOffer]);

  const disconnect = useCallback(async () => {
    pcRef.current?.close(); pcRef.current = null;
    await channelRef.current?.unsubscribe(); channelRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    document.exitPointerLock?.();
    setStatus("idle"); setIsPointerLocked(false);
  }, []);

  // ── Input ─────────────────────────────────────────────────────────────
  const send = useCallback((cmd) => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(cmd));
  }, []);

  const getRenderRect = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    const cr   = video.getBoundingClientRect();
    const vidW = resolution.w || video.videoWidth  || 1920;
    const vidH = resolution.h || video.videoHeight || 1080;
    const ca = cr.width / cr.height, va = vidW / vidH;
    let renderW, renderH, offsetX, offsetY;
    if (ca > va) { renderH = cr.height; renderW = renderH * va; offsetX = (cr.width - renderW) / 2; offsetY = 0; }
    else         { renderW = cr.width;  renderH = renderW / va; offsetX = 0; offsetY = (cr.height - renderH) / 2; }
    return { renderW, renderH, offsetX, offsetY, vidW, vidH };
  }, [resolution]);

  const getScaledCoords = useCallback((e) => {
    const r = getRenderRect();
    if (!r) return { x: 0, y: 0 };
    const cr = videoRef.current.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(r.vidW, ((e.clientX - cr.left - r.offsetX) / r.renderW) * r.vidW))),
      y: Math.round(Math.max(0, Math.min(r.vidH, ((e.clientY - cr.top  - r.offsetY) / r.renderH) * r.vidH))),
    };
  }, [getRenderRect]);

  const getCursorPixelPos = useCallback(() => {
    const r = getRenderRect();
    if (!r) return { left: -100, top: -100 };
    return {
      left: r.offsetX + (remoteCursor.x / remoteCursor.sw) * r.renderW,
      top:  r.offsetY + (remoteCursor.y / remoteCursor.sh) * r.renderH,
    };
  }, [remoteCursor, getRenderRect]);

  const enablePointerLock = useCallback(() => { containerRef.current?.requestPointerLock(); }, []);

  useEffect(() => {
    const fn = () => setIsPointerLocked(document.pointerLockElement === containerRef.current);
    document.addEventListener("pointerlockchange", fn);
    return () => document.removeEventListener("pointerlockchange", fn);
  }, []);

  const accPos = useRef({ x: 960, y: 540 });

  // ── Mouse handlers — draw mode vs control mode ─────────────────────────
  const handleMouseMove = useCallback((e) => {
    if (drawMode) {
      if (!isDrawing.current) return;
      const { x, y } = getScaledCoords(e);
      send({ type: "draw-point", x, y, color: drawColor, width: drawWidth });
      return;
    }
    if (!isPointerLocked) {
      const { x, y } = getScaledCoords(e);
      send({ type: "mousemove", x, y });
    } else {
      const r = getRenderRect();
      if (!r) return;
      accPos.current.x = Math.max(0, Math.min(r.vidW, accPos.current.x + e.movementX * (r.vidW / r.renderW)));
      accPos.current.y = Math.max(0, Math.min(r.vidH, accPos.current.y + e.movementY * (r.vidH / r.renderH)));
      send({ type: "mousemove", x: Math.round(accPos.current.x), y: Math.round(accPos.current.y) });
    }
  }, [drawMode, drawColor, drawWidth, isPointerLocked, getScaledCoords, getRenderRect, send]);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    if (drawMode) {
      isDrawing.current = true;
      const { x, y } = getScaledCoords(e);
      send({ type: "draw-point", x, y, color: drawColor, width: drawWidth, start: true });
      return;
    }
    send({ type: "mousedown", button: ["left","middle","right"][e.button] || "left", ...getScaledCoords(e) });
  }, [drawMode, drawColor, drawWidth, getScaledCoords, send]);

  const handleMouseUp = useCallback((e) => {
    if (drawMode) {
      isDrawing.current = false;
      send({ type: "draw-end" });
      return;
    }
    send({ type: "mouseup", button: ["left","middle","right"][e.button] || "left", ...getScaledCoords(e) });
  }, [drawMode, getScaledCoords, send]);

  const handleWheel = useCallback((e) => {
    if (drawMode) return;
    e.preventDefault();
    send({ type: "scroll", ...getScaledCoords(e), deltaY: e.deltaY });
  }, [drawMode, getScaledCoords, send]);

  const handleKeyDown = useCallback((e) => {
    if (status !== "connected" || drawMode) return;
    e.preventDefault();
    send({ type: "keydown", key: e.key, code: e.code });
  }, [status, drawMode, send]);

  const handleKeyUp = useCallback((e) => {
    if (status !== "connected" || drawMode) return;
    e.preventDefault();
    send({ type: "keyup", key: e.key, code: e.code });
  }, [status, drawMode, send]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => { window.removeEventListener("keydown", handleKeyDown); window.removeEventListener("keyup", handleKeyUp); };
  }, [handleKeyDown, handleKeyUp]);

  useEffect(() => {
    if (status !== "connected") return;
    const iv = setInterval(() => {
      const now = Date.now(), elapsed = (now - fpsCounterRef.current.last) / 1000;
      setFps(Math.round(fpsCounterRef.current.frames / elapsed));
      fpsCounterRef.current = { frames: 0, last: now };
    }, 1000);
    const video = videoRef.current;
    const onF = () => { fpsCounterRef.current.frames++; };
    video?.addEventListener("timeupdate", onF);
    return () => { clearInterval(iv); video?.removeEventListener("timeupdate", onF); };
  }, [status]);

  const cursorPos = getCursorPixelPos();

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>⬡</span>
          <span style={styles.logoText}>RemoteDesk</span>
        </div>
        <div style={styles.statusRow}>
          {status === "connected" && (
            <>
              <span style={styles.stat}>{fps} fps</span>
              {resolution.w > 0 && <span style={styles.stat}>{resolution.w}×{resolution.h}</span>}
              <span style={{ ...styles.dot, background: "#22c55e" }} />
            </>
          )}
          {status === "connecting" && <><span style={styles.stat}>Connecting…</span><span style={{ ...styles.dot, background: "#f59e0b", animation: "pulse 1s infinite" }} /></>}
          {status === "idle"  && <span style={styles.stat}>Not connected</span>}
          {status === "error" && <span style={{ ...styles.stat, color: "#f87171" }}>{error}</span>}
        </div>
        <div style={styles.controls}>
          {isPointerLocked && <span style={styles.hint}>ESC to release mouse</span>}
          {status === "connected" && !isPointerLocked && !drawMode && (
            <button style={styles.btn} onClick={enablePointerLock}>Lock Mouse</button>
          )}
          {status !== "connected" && status !== "connecting"
            ? <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={connect}>Connect</button>
            : <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={disconnect}>Disconnect</button>
          }
        </div>
      </div>

      {/* Drawing toolbar — only when connected */}
      {status === "connected" && (
        <div style={styles.toolbar}>
          {/* Mode toggle */}
          <button
            style={{ ...styles.toolBtn, ...(drawMode ? styles.toolBtnActive : {}) }}
            onClick={() => setDrawMode(m => !m)}
            title="Draw mode"
          >
            ✏️ {drawMode ? "Drawing" : "Draw"}
          </button>

          {drawMode && (
            <>
              <div style={styles.toolDivider} />
              {/* Color picker */}
              {COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setDrawColor(c)}
                  style={{
                    ...styles.colorSwatch,
                    background: c,
                    boxShadow: drawColor === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : "none",
                  }}
                />
              ))}
              <div style={styles.toolDivider} />
              {/* Width picker */}
              {WIDTHS.map(w => (
                <button
                  key={w}
                  onClick={() => setDrawWidth(w)}
                  style={{ ...styles.toolBtn, ...(drawWidth === w ? styles.toolBtnActive : {}), minWidth: 32 }}
                >
                  <div style={{ width: w, height: w, borderRadius: "50%", background: drawColor, margin: "0 auto" }} />
                </button>
              ))}
              <div style={styles.toolDivider} />
              {/* Clear */}
              <button
                style={{ ...styles.toolBtn, color: "#f87171" }}
                onClick={() => send({ type: "draw-clear" })}
              >
                🗑 Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* Screen area */}
      <div style={styles.screenWrap}>
        {status === "idle" && (
          <div style={styles.splash}>
            <div style={styles.splashIcon}>⬡</div>
            <h1 style={styles.splashTitle}>RemoteDesk</h1>
            <p style={styles.splashSub}>Peer-to-peer remote desktop.<br />Start the agent on your Windows PC, then click Connect.</p>
            <button style={{ ...styles.btn, ...styles.btnPrimary, ...styles.btnLarge }} onClick={connect}>Connect to PC</button>
            <div style={styles.steps}>
              <div style={styles.step}><span style={styles.stepNum}>1</span> Run <code style={styles.code}>python agent.py</code> on your PC</div>
              <div style={styles.step}><span style={styles.stepNum}>2</span> Click Connect above</div>
              <div style={styles.step}><span style={styles.stepNum}>3</span> Control your desktop remotely</div>
            </div>
          </div>
        )}
        {status === "connecting" && (
          <div style={styles.splash}>
            <div style={styles.spinner} />
            <p style={styles.splashSub}>Waiting for PC agent…</p>
            <p style={styles.splashHint}>Make sure <code style={styles.code}>python agent.py</code> is running on your PC</p>
          </div>
        )}

        <div
          ref={containerRef}
          style={{
            ...styles.videoContainer,
            display: status === "connected" ? "block" : "none",
            cursor: drawMode ? "crosshair" : "none",
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          onClick={!drawMode ? enablePointerLock : undefined}
        >
          <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

          {/* Remote cursor — hide in draw mode */}
          {!drawMode && (
            <div style={{ position: "absolute", left: cursorPos.left, top: cursorPos.top, width: 20, height: 20, transform: "translate(-2px,-2px)", pointerEvents: "none", zIndex: 10 }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M2 2L2 14L5.5 10.5L8 17L10 16L7.5 9.5L12 9.5L2 2Z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #090c10; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:none} }
      `}</style>
    </div>
  );
}

const styles = {
  root: { fontFamily: "'Syne', sans-serif", background: "#090c10", color: "#e2e8f0", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 52, background: "#0d1117", borderBottom: "1px solid #1e2733", flexShrink: 0, gap: 16 },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoIcon: { fontSize: 20, color: "#38bdf8" },
  logoText: { fontWeight: 800, fontSize: 16, letterSpacing: "-0.03em", color: "#f1f5f9" },
  statusRow: { display: "flex", alignItems: "center", gap: 10, flex: 1, justifyContent: "center" },
  stat: { fontFamily: "'Space Mono', monospace", fontSize: 11, color: "#64748b" },
  dot: { width: 7, height: 7, borderRadius: "50%" },
  controls: { display: "flex", alignItems: "center", gap: 10 },
  hint: { fontFamily: "'Space Mono', monospace", fontSize: 10, color: "#475569" },
  btn: { padding: "6px 14px", borderRadius: 6, border: "1px solid #1e2733", background: "#141b24", color: "#94a3b8", fontSize: 12, fontFamily: "'Syne', sans-serif", fontWeight: 600, cursor: "pointer" },
  btnPrimary: { background: "#0ea5e9", border: "1px solid #38bdf8", color: "#fff" },
  btnDanger: { background: "#1a1a2e", border: "1px solid #f87171", color: "#f87171" },
  btnLarge: { padding: "12px 28px", fontSize: 14, borderRadius: 8 },
  toolbar: { display: "flex", alignItems: "center", gap: 6, padding: "6px 16px", background: "#0d1117", borderBottom: "1px solid #1e2733", flexShrink: 0, flexWrap: "wrap" },
  toolBtn: { padding: "4px 10px", borderRadius: 5, border: "1px solid #1e2733", background: "#141b24", color: "#94a3b8", fontSize: 12, fontFamily: "'Syne', sans-serif", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 },
  toolBtnActive: { background: "#1e3a5f", border: "1px solid #38bdf8", color: "#e2e8f0" },
  toolDivider: { width: 1, height: 20, background: "#1e2733", margin: "0 4px" },
  colorSwatch: { width: 18, height: 18, borderRadius: "50%", border: "none", cursor: "pointer", flexShrink: 0 },
  screenWrap: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" },
  videoContainer: { position: "absolute", inset: 0, background: "#000" },
  video: { width: "100%", height: "100%", objectFit: "contain", display: "block" },
  splash: { display: "flex", flexDirection: "column", alignItems: "center", gap: 20, textAlign: "center", animation: "fadeIn 0.4s ease", padding: 40 },
  splashIcon: { fontSize: 48, color: "#38bdf8", lineHeight: 1 },
  splashTitle: { fontSize: 42, fontWeight: 800, letterSpacing: "-0.04em", color: "#f1f5f9" },
  splashSub: { fontSize: 15, color: "#64748b", lineHeight: 1.7, maxWidth: 380 },
  splashHint: { fontSize: 13, color: "#334155", fontFamily: "'Space Mono', monospace" },
  spinner: { width: 36, height: 36, border: "3px solid #1e2733", borderTop: "3px solid #38bdf8", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  steps: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 },
  step: { display: "flex", alignItems: "center", gap: 10, color: "#475569", fontSize: 13 },
  stepNum: { width: 22, height: 22, borderRadius: "50%", background: "#1e2733", color: "#38bdf8", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  code: { fontFamily: "'Space Mono', monospace", background: "#0d1117", border: "1px solid #1e2733", borderRadius: 4, padding: "1px 6px", fontSize: 12, color: "#38bdf8" },
};
