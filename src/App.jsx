import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CHANNEL_NAME = "remotedesk-signal";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

export default function App() {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [resolution, setResolution] = useState({ w: 0, h: 0 });
  const [fps, setFps] = useState(0);
  const [remoteCursor, setRemoteCursor] = useState({ x: -100, y: -100, sw: 1920, sh: 1080 });

  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const dataChannelRef = useRef(null);
  const supabaseRef = useRef(null);
  const fpsCounterRef = useRef({ frames: 0, last: Date.now() });
  const containerRef = useRef(null);

  const setupSignaling = useCallback(async () => {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supabaseRef.current = supabase;
    const channel = supabase.channel(CHANNEL_NAME, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;
    channel.on("broadcast", { event: "signal" }, async ({ payload }) => {
      await handleSignal(payload);
    });
    await channel.subscribe();
    return channel;
  }, []);

  const broadcast = useCallback(async (payload) => {
    if (channelRef.current) {
      await channelRef.current.send({ type: "broadcast", event: "signal", payload });
    }
  }, []);

  const handleSignal = useCallback(async (data) => {
    // Handle remote cursor position updates
    if (data.type === "cursor-pos") {
      setRemoteCursor({ x: data.x, y: data.y, sw: data.sw, sh: data.sh });
      return;
    }

    const pc = pcRef.current;
    if (!pc) return;
    if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
    } else if (data.type === "ice-candidate" && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data)); }
      catch (e) { console.warn("ICE candidate error:", e); }
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
      setStatus("connecting");
      setError(null);
      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;
      const dc = pc.createDataChannel("input", { ordered: false, maxRetransmits: 0 });
      dataChannelRef.current = dc;
      dc.onopen = () => console.log("Data channel open");
      dc.onclose = () => console.log("Data channel closed");
      pc.ontrack = (event) => {
        if (videoRef.current && event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
          setStatus("connected");
          const track = event.streams[0].getVideoTracks()[0];
          const settings = track.getSettings();
          setResolution({ w: settings.width || 0, h: settings.height || 0 });
        }
      };
      pc.onicecandidate = async (event) => {
        if (event.candidate) {
          await broadcast({
            type: "ice-candidate",
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        }
      };
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "failed" || state === "disconnected") {
          setStatus("error");
          setError("Connection lost. Is the agent running?");
        }
      };
      await setupSignaling();
      await broadcast({ type: "browser-connected" });
      setTimeout(async () => {
        if (status !== "connected") await initiateOffer();
      }, 3000);
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }, [setupSignaling, broadcast, initiateOffer]);

  const disconnect = useCallback(async () => {
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (channelRef.current) { await channelRef.current.unsubscribe(); channelRef.current = null; }
    if (videoRef.current) { videoRef.current.srcObject = null; }
    document.exitPointerLock?.();
    setStatus("idle");
    setIsPointerLocked(false);
  }, []);

  const send = useCallback((cmd) => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(cmd));
  }, []);

  // Compute letterbox-aware render rect
  const getRenderRect = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    const containerRect = video.getBoundingClientRect();
    const vidW = resolution.w || video.videoWidth || 1920;
    const vidH = resolution.h || video.videoHeight || 1080;
    const containerAspect = containerRect.width / containerRect.height;
    const videoAspect = vidW / vidH;
    let renderW, renderH, offsetX, offsetY;
    if (containerAspect > videoAspect) {
      renderH = containerRect.height;
      renderW = renderH * videoAspect;
      offsetX = (containerRect.width - renderW) / 2;
      offsetY = 0;
    } else {
      renderW = containerRect.width;
      renderH = renderW / videoAspect;
      offsetX = 0;
      offsetY = (containerRect.height - renderH) / 2;
    }
    return { renderW, renderH, offsetX, offsetY, vidW, vidH };
  }, [resolution]);

  const getScaledCoords = useCallback((e) => {
    const r = getRenderRect();
    if (!r) return { x: 0, y: 0 };
    const containerRect = videoRef.current.getBoundingClientRect();
    const mouseX = e.clientX - containerRect.left - r.offsetX;
    const mouseY = e.clientY - containerRect.top - r.offsetY;
    return {
      x: Math.round(Math.max(0, Math.min(r.vidW, (mouseX / r.renderW) * r.vidW))),
      y: Math.round(Math.max(0, Math.min(r.vidH, (mouseY / r.renderH) * r.vidH))),
    };
  }, [getRenderRect]);

  // Convert remote cursor screen coords → pixel position on the video element
  const getCursorPixelPos = useCallback(() => {
    const r = getRenderRect();
    if (!r) return { left: -100, top: -100 };
    // remoteCursor.x/y are in physical screen pixels (sw × sh)
    // map to video coords first, then to render rect pixels
    const vx = (remoteCursor.x / remoteCursor.sw) * r.vidW;
    const vy = (remoteCursor.y / remoteCursor.sh) * r.vidH;
    return {
      left: r.offsetX + (vx / r.vidW) * r.renderW,
      top:  r.offsetY + (vy / r.vidH) * r.renderH,
    };
  }, [remoteCursor, getRenderRect]);

  const enablePointerLock = useCallback(() => {
    containerRef.current?.requestPointerLock();
  }, []);

  useEffect(() => {
    const onLockChange = () => {
      setIsPointerLocked(document.pointerLockElement === containerRef.current);
    };
    document.addEventListener("pointerlockchange", onLockChange);
    return () => document.removeEventListener("pointerlockchange", onLockChange);
  }, []);

  const accPos = useRef({ x: 960, y: 540 });

  const handleMouseMove = useCallback((e) => {
    if (!isPointerLocked) {
      const { x, y } = getScaledCoords(e);
      send({ type: "mousemove", x, y });
    } else {
      const r = getRenderRect();
      if (!r) return;
      const scaleX = r.vidW / r.renderW;
      const scaleY = r.vidH / r.renderH;
      accPos.current.x = Math.max(0, Math.min(r.vidW, accPos.current.x + e.movementX * scaleX));
      accPos.current.y = Math.max(0, Math.min(r.vidH, accPos.current.y + e.movementY * scaleY));
      send({ type: "mousemove", x: Math.round(accPos.current.x), y: Math.round(accPos.current.y) });
    }
  }, [isPointerLocked, getScaledCoords, getRenderRect, send]);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    const btn = ["left", "middle", "right"][e.button] || "left";
    const { x, y } = getScaledCoords(e);
    send({ type: "mousedown", button: btn, x, y });
  }, [getScaledCoords, send]);

  const handleMouseUp = useCallback((e) => {
    const btn = ["left", "middle", "right"][e.button] || "left";
    const { x, y } = getScaledCoords(e);
    send({ type: "mouseup", button: btn, x, y });
  }, [getScaledCoords, send]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const { x, y } = getScaledCoords(e);
    send({ type: "scroll", x, y, deltaY: e.deltaY });
  }, [getScaledCoords, send]);

  const handleKeyDown = useCallback((e) => {
    if (status !== "connected") return;
    e.preventDefault();
    send({ type: "keydown", key: e.key, code: e.code });
  }, [status, send]);

  const handleKeyUp = useCallback((e) => {
    if (status !== "connected") return;
    e.preventDefault();
    send({ type: "keyup", key: e.key, code: e.code });
  }, [status, send]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  useEffect(() => {
    if (status !== "connected") return;
    const interval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - fpsCounterRef.current.last) / 1000;
      setFps(Math.round(fpsCounterRef.current.frames / elapsed));
      fpsCounterRef.current = { frames: 0, last: now };
    }, 1000);
    const video = videoRef.current;
    const onFrame = () => { fpsCounterRef.current.frames++; };
    video?.addEventListener("timeupdate", onFrame);
    return () => { clearInterval(interval); video?.removeEventListener("timeupdate", onFrame); };
  }, [status]);

  const cursorPos = getCursorPixelPos();

  return (
    <div style={styles.root}>
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
          {status === "connecting" && (
            <>
              <span style={styles.stat}>Connecting…</span>
              <span style={{ ...styles.dot, background: "#f59e0b", animation: "pulse 1s infinite" }} />
            </>
          )}
          {status === "idle" && <span style={styles.stat}>Not connected</span>}
          {status === "error" && <span style={{ ...styles.stat, color: "#f87171" }}>{error}</span>}
        </div>
        <div style={styles.controls}>
          {isPointerLocked && <span style={styles.hint}>Press ESC to release mouse</span>}
          {status === "connected" && !isPointerLocked && (
            <button style={styles.btn} onClick={enablePointerLock}>Lock Mouse</button>
          )}
          {status !== "connected" && status !== "connecting" ? (
            <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={connect}>Connect</button>
          ) : (
            <button style={{ ...styles.btn, ...styles.btnDanger }} onClick={disconnect}>Disconnect</button>
          )}
        </div>
      </div>

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
            cursor: "none", // always hide browser cursor over video
          }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          onClick={enablePointerLock}
        >
          <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

          {/* Remote cursor overlay */}
          <div
            style={{
              position: "absolute",
              left: cursorPos.left,
              top: cursorPos.top,
              width: 20,
              height: 20,
              transform: "translate(-2px, -2px)",
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            {/* Arrow cursor shape in SVG */}
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 2L2 14L5.5 10.5L8 17L10 16L7.5 9.5L12 9.5L2 2Z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #090c10; }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:none } }
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
  stat: { fontFamily: "'Space Mono', monospace", fontSize: 11, color: "#64748b", letterSpacing: "0.02em" },
  dot: { width: 7, height: 7, borderRadius: "50%" },
  controls: { display: "flex", alignItems: "center", gap: 10 },
  hint: { fontFamily: "'Space Mono', monospace", fontSize: 10, color: "#475569" },
  btn: { padding: "6px 14px", borderRadius: 6, border: "1px solid #1e2733", background: "#141b24", color: "#94a3b8", fontSize: 12, fontFamily: "'Syne', sans-serif", fontWeight: 600, cursor: "pointer", transition: "all 0.15s" },
  btnPrimary: { background: "#0ea5e9", border: "1px solid #38bdf8", color: "#fff" },
  btnDanger: { background: "#1a1a2e", border: "1px solid #f87171", color: "#f87171" },
  btnLarge: { padding: "12px 28px", fontSize: 14, borderRadius: 8 },
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
