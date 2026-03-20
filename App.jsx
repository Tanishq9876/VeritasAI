import { useState, useRef, useEffect, useCallback } from "react";

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:       "#F7F6F3",
  surface:  "#FFFFFF",
  border:   "#E4E2DC",
  borderMd: "#D0CEC6",
  text:     "#1A1917",
  muted:    "#6B6960",
  faint:    "#A09E97",
  accent:   "#1A56DB",
  accentBg: "#EEF3FD",

  true:       { fg: "#166534", bg: "#F0FDF4", border: "#BBF7D0", dot: "#22C55E" },
  false:      { fg: "#991B1B", bg: "#FFF5F5", border: "#FECACA", dot: "#EF4444" },
  misleading: { fg: "#92400E", bg: "#FFFBEB", border: "#FDE68A", dot: "#F59E0B" },
  unverified: { fg: "#374151", bg: "#F9FAFB", border: "#E5E7EB", dot: "#9CA3AF" },

  fontDisplay: "'Playfair Display', Georgia, serif",
  fontBody:    "'DM Sans', system-ui, sans-serif",
  fontMono:    "'DM Mono', 'Courier New', monospace",
};

const VERDICTS = {
  TRUE:       { label: "Verified True",   short: "True",       ...T.true },
  FALSE:      { label: "False",           short: "False",      ...T.false },
  MISLEADING: { label: "Misleading",      short: "Misleading", ...T.misleading },
  UNVERIFIED: { label: "Unverified",      short: "Unverified", ...T.unverified },
};

const PATTERNS = [
  { re: /forward this to/i,                               label: "Chain-message language" },
  { re: /share with everyone/i,                           label: "Mass-share request" },
  { re: /government.{0,25}(announced|confirmed|banned)/i, label: "Unverified government claim" },
  { re: /urgent|act now|immediately/i,                    label: "Artificial urgency" },
  { re: /100%\s*(natural|cure|safe|effective)/i,          label: "Absolute health claim" },
  { re: /doctors.{0,15}(hate|don't want)/i,               label: "Anti-expert framing" },
  { re: /bit\.ly|tinyurl|t\.co/i,                         label: "Shortened URL" },
];

const TEXT_STEPS  = ["Parsing message structure…","Extracting verifiable claims…","Cross-referencing fact-check databases…","Consulting primary sources…","Computing confidence score…","Generating verdict…"];
const IMAGE_STEPS = ["Reading image content…","Detecting text and visual claims…","Analysing visual context…","Cross-referencing with known sources…","Computing confidence score…","Generating verdict…"];
const VIDEO_STEPS = ["Extracting representative frame…","Analysing visual content…","Detecting on-screen text…","Evaluating visual claims…","Computing confidence score…","Generating verdict…"];

const ACCEPT_IMAGE = "image/jpeg,image/png,image/webp,image/gif";
const ACCEPT_VIDEO = "video/mp4,video/webm,video/quicktime,video/x-matroska";
const MAX_IMAGE_MB = 4;
const MAX_VIDEO_MB = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Convert File → base64 data string (no prefix)
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Extract a frame from a video file as base64 JPEG
function extractVideoFrame(file, timeSeconds = 1.5) {
  return new Promise((res, rej) => {
    const url    = URL.createObjectURL(file);
    const video  = document.createElement("video");
    video.src    = url;
    video.muted  = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";

    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(timeSeconds, video.duration * 0.3);
    });
    video.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas");
      canvas.width  = Math.min(video.videoWidth,  1280);
      canvas.height = Math.min(video.videoHeight, 720);
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      canvas.width  = Math.round(video.videoWidth  * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      res(dataUrl.split(",")[1]);
    });
    video.addEventListener("error", rej);
    video.load();
  });
}

// ─── API calls ────────────────────────────────────────────────────────────────
const SYSTEM = `You are Veritas, a professional fact-checking engine.
Return ONLY valid JSON — no markdown fences, no preamble:
{
  "overallVerdict": "TRUE"|"FALSE"|"MISLEADING"|"UNVERIFIED",
  "confidenceScore": <0-100>,
  "summary": "<2-3 sentence assessment, formal tone>",
  "claims": [
    {
      "text": "<extracted claim>",
      "verdict": "TRUE"|"FALSE"|"MISLEADING"|"UNVERIFIED",
      "explanation": "<clear, concise explanation>",
      "sources": [{ "title": "<name>", "url": "<url>" }]
    }
  ],
  "redFlags": ["<specific concern>"],
  "context": "<relevant background or historical context>"
}
Extract 1–3 key claims. Use authoritative sources: Reuters, AP, BBC, WHO, CDC, Snopes, PolitiFact, FactCheck.org.`;

async function analyseText(text) {
  const prompt = `${SYSTEM}\n\nFact-check the following:\n\n${text}`;
  const res = await fetch("/.netlify/functions/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const d = await res.json();
  const raw = d.text || "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function analyseImage(base64, mimeType, caption = "") {
  const prompt = `${SYSTEM}\n\nPlease fact-check this image.${caption ? ` The user added this caption: "${caption}"` : ""} Describe what you see, extract any visible text or claims, and evaluate their accuracy. The image is provided as base64: data:${mimeType};base64,${base64}`;
  const res = await fetch("/.netlify/functions/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const d = await res.json();
  const raw = d.text || "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── Shared UI components ─────────────────────────────────────────────────────
function Chip({ verdict }) {
  const v = VERDICTS[verdict] || VERDICTS.UNVERIFIED;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: v.bg, border: `1px solid ${v.border}`, color: v.fg,
      borderRadius: 6, padding: "3px 10px",
      fontSize: 12, fontWeight: 600, fontFamily: T.fontMono,
      letterSpacing: "0.04em", whiteSpace: "nowrap",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: v.dot, flexShrink: 0 }} />
      {v.short.toUpperCase()}
    </span>
  );
}

function ScoreBar({ score }) {
  const [w, setW] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setW(score)); return () => cancelAnimationFrame(id); }, [score]);
  const color = score >= 70 ? T.true.dot : score >= 40 ? T.misleading.dot : T.false.dot;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: T.muted, letterSpacing: "0.08em", fontFamily: T.fontMono }}>CONFIDENCE SCORE</span>
        <span style={{ fontSize: 28, fontWeight: 700, color: T.text, fontFamily: T.fontDisplay, lineHeight: 1 }}>{score}<span style={{ fontSize: 16, color: T.muted }}>%</span></span>
      </div>
      <div style={{ background: T.border, borderRadius: 3, height: 4, overflow: "hidden" }}>
        <div style={{ width: `${w}%`, height: "100%", background: color, borderRadius: 3, transition: "width 1.1s cubic-bezier(0.4,0,0.2,1)" }} />
      </div>
    </div>
  );
}

function ClaimCard({ claim, i }) {
  const [open, setOpen] = useState(true);
  const v = VERDICTS[claim.verdict] || VERDICTS.UNVERIFIED;
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", background: T.surface, animation: `rise 0.35s ease ${i * 0.08}s both` }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, textAlign: "left" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: v.dot, flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: T.text, lineHeight: 1.45 }}>{claim.text}</span>
        <Chip verdict={claim.verdict} />
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s", color: T.faint }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px 36px", borderTop: `1px solid ${T.border}` }}>
          <p style={{ fontSize: 14, color: T.muted, lineHeight: 1.7, margin: "14px 0 12px" }}>{claim.explanation}</p>
          {claim.sources?.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {claim.sources.map((s, j) => (
                <a key={j} href={s.url} target="_blank" rel="noopener noreferrer" style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 12, color: T.accent, fontWeight: 600,
                  background: T.accentBg, border: "1px solid #C7D9F8",
                  borderRadius: 6, padding: "4px 10px", textDecoration: "none",
                }}
                  onMouseOver={e => e.currentTarget.style.opacity = "0.75"}
                  onMouseOut={e  => e.currentTarget.style.opacity = "1"}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 9.5l7-7M9.5 9.5V2.5H2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  {s.title}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: T.faint, fontFamily: T.fontMono, marginBottom: 10 }}>{label}</p>
      {children}
    </div>
  );
}

function Divider() { return <div style={{ height: 1, background: T.border, margin: "4px 0" }} />; }

// ─── Results panel (shared by all modes) ─────────────────────────────────────
function ResultsPanel({ result, flags, onCopy, copied, onReset }) {
  const v = VERDICTS[result.overallVerdict] || VERDICTS.UNVERIFIED;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Verdict */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", animation: "rise 0.35s ease", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <div style={{ background: v.bg, borderBottom: `1px solid ${v.border}`, padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: v.dot }} />
            <span style={{ fontFamily: T.fontDisplay, fontSize: 22, fontWeight: 700, color: v.fg }}>{v.label}</span>
          </div>
          <button onClick={onCopy} style={{ background: copied ? T.true.bg : T.surface, border: `1px solid ${copied ? T.true.border : T.border}`, color: copied ? T.true.fg : T.muted, borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>
            {copied ? "Copied" : "Copy Result"}
          </button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          <ScoreBar score={result.confidenceScore} />
          <Divider />
          <p style={{ fontSize: 15, color: T.muted, lineHeight: 1.75 }}>{result.summary}</p>
        </div>
      </div>

      {/* Pattern flags */}
      {flags.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.misleading.border}`, borderRadius: 12, padding: "18px 20px", animation: "rise 0.35s ease 0.05s both" }}>
          <Section label="SUSPICIOUS PATTERNS DETECTED">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {flags.map((f, i) => (
                <span key={i} style={{ fontSize: 12, fontWeight: 500, background: T.misleading.bg, border: `1px solid ${T.misleading.border}`, color: T.misleading.fg, borderRadius: 6, padding: "4px 10px" }}>{f.label}</span>
              ))}
            </div>
          </Section>
        </div>
      )}

      {/* Claims */}
      {result.claims?.length > 0 && (
        <div style={{ animation: "rise 0.35s ease 0.1s both" }}>
          <Section label={`EXTRACTED CLAIMS · ${result.claims.length}`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.claims.map((c, i) => <ClaimCard key={i} claim={c} i={i} />)}
            </div>
          </Section>
        </div>
      )}

      {/* Red flags */}
      {result.redFlags?.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.false.border}`, borderRadius: 12, padding: "18px 20px", animation: "rise 0.35s ease 0.15s both" }}>
          <Section label="ADDITIONAL CONCERNS">
            <ul style={{ paddingLeft: 16, display: "flex", flexDirection: "column", gap: 6 }}>
              {result.redFlags.map((f, i) => <li key={i} style={{ fontSize: 14, color: T.muted, lineHeight: 1.6 }}>{f}</li>)}
            </ul>
          </Section>
        </div>
      )}

      {/* Context */}
      {result.context && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "18px 20px", animation: "rise 0.35s ease 0.2s both" }}>
          <Section label="CONTEXT">
            <p style={{ fontSize: 14, color: T.muted, lineHeight: 1.75 }}>{result.context}</p>
          </Section>
        </div>
      )}

      {/* Reset */}
      <button onClick={onReset} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 9, padding: "11px", color: T.muted, fontSize: 14, fontWeight: 500, cursor: "pointer", width: "100%", transition: "border-color 0.15s, color 0.15s" }}
        onMouseOver={e => { e.currentTarget.style.borderColor = T.borderMd; e.currentTarget.style.color = T.text; }}
        onMouseOut={e  => { e.currentTarget.style.borderColor = T.border;   e.currentTarget.style.color = T.muted; }}
      >Analyse another item</button>
    </div>
  );
}

// ─── Loading panel ────────────────────────────────────────────────────────────
function LoadingPanel({ step }) {
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: "28px 24px", marginBottom: 4, animation: "rise 0.3s ease" }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: T.faint, letterSpacing: "0.09em", fontFamily: T.fontMono, marginBottom: 14 }}>ANALYSIS IN PROGRESS</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20 }}>
        <div style={{ width: 36, height: 36, borderRadius: 9, background: T.bg, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <div style={{ width: 16, height: 16, border: `2px solid ${T.borderMd}`, borderTopColor: T.text, borderRadius: "50%", animation: "spin 0.75s linear infinite" }} />
        </div>
        <span style={{ fontSize: 14, color: T.muted }}>{step}</span>
      </div>
      <div style={{ background: T.border, borderRadius: 3, height: 3 }}>
        <div style={{ width: "55%", height: "100%", background: T.text, borderRadius: 3 }} />
      </div>
    </div>
  );
}

// ─── Drop-zone / file picker ──────────────────────────────────────────────────
function MediaDropZone({ onFile, accept, label, hint, icon }) {
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  }, [onFile]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => ref.current?.click()}
      style={{
        border: `2px dashed ${dragging ? T.accent : T.borderMd}`,
        borderRadius: 12, padding: "36px 24px", textAlign: "center",
        cursor: "pointer", transition: "all 0.2s",
        background: dragging ? T.accentBg : T.surface,
      }}
      onMouseOver={e => { if (!dragging) e.currentTarget.style.background = T.bg; }}
      onMouseOut={e  => { if (!dragging) e.currentTarget.style.background = T.surface; }}
    >
      <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={e => { if (e.target.files?.[0]) onFile(e.target.files[0]); }} />
      <div style={{ fontSize: 32, marginBottom: 12, lineHeight: 1 }}>{icon}</div>
      <p style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 6 }}>{label}</p>
      <p style={{ fontSize: 13, color: T.faint }}>{hint}</p>
    </div>
  );
}

// ─── Image preview with caption ───────────────────────────────────────────────
function ImagePreview({ file, previewUrl, caption, onCaption, onRemove }) {
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", background: T.surface }}>
      <div style={{ position: "relative" }}>
        <img src={previewUrl} alt="Preview" style={{ width: "100%", maxHeight: 320, objectFit: "contain", display: "block", background: T.bg }} />
        <button onClick={onRemove} style={{
          position: "absolute", top: 10, right: 10,
          background: "rgba(0,0,0,0.55)", border: "none", color: "#fff",
          borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
        }}>Remove</button>
      </div>
      <div style={{ padding: "12px 16px", borderTop: `1px solid ${T.border}`, background: T.bg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: T.muted, fontFamily: T.fontMono, fontWeight: 600 }}>{file.name}</span>
          <span style={{ fontSize: 12, color: T.faint }}>·</span>
          <span style={{ fontSize: 12, color: T.faint }}>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
        </div>
        <input
          type="text"
          value={caption}
          onChange={e => onCaption(e.target.value)}
          placeholder="Optional: add context or caption…"
          style={{
            width: "100%", border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "8px 12px", fontSize: 14, fontFamily: T.fontBody,
            color: T.text, background: T.surface, outline: "none",
          }}
          onFocus={e => e.target.style.borderColor = T.accent}
          onBlur={e  => e.target.style.borderColor = T.border}
        />
      </div>
    </div>
  );
}

// ─── Video preview ────────────────────────────────────────────────────────────
function VideoPreview({ file, frameUrl, onRemove }) {
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", background: T.surface }}>
      <div style={{ display: "grid", gridTemplateColumns: frameUrl ? "1fr 1fr" : "1fr", gap: 0 }}>
        <div style={{ position: "relative", background: "#000" }}>
          <video src={URL.createObjectURL(file)} controls style={{ width: "100%", maxHeight: 260, display: "block" }} />
          <button onClick={onRemove} style={{
            position: "absolute", top: 10, right: 10,
            background: "rgba(0,0,0,0.6)", border: "none", color: "#fff",
            borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
          }}>Remove</button>
        </div>
        {frameUrl && (
          <div style={{ background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, gap: 8, borderLeft: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 11, color: T.faint, fontFamily: T.fontMono, fontWeight: 600, letterSpacing: "0.08em" }}>EXTRACTED FRAME</p>
            <img src={`data:image/jpeg;base64,${frameUrl}`} alt="Frame" style={{ width: "100%", borderRadius: 6, border: `1px solid ${T.border}` }} />
            <p style={{ fontSize: 11, color: T.faint, textAlign: "center", lineHeight: 1.5 }}>This frame will be analysed for visual claims</p>
          </div>
        )}
      </div>
      <div style={{ padding: "10px 16px", borderTop: `1px solid ${T.border}`, background: T.bg, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: T.muted, fontFamily: T.fontMono, fontWeight: 600 }}>{file.name}</span>
        <span style={{ fontSize: 12, color: T.faint }}>·</span>
        <span style={{ fontSize: 12, color: T.faint }}>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
        {!frameUrl && <span style={{ fontSize: 12, color: T.muted, marginLeft: "auto" }}>Extracting frame…</span>}
      </div>
    </div>
  );
}

// ─── Mode tab selector ────────────────────────────────────────────────────────
const MODES = [
  {
    id: "text", label: "Text",
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 3h11M2 7.5h11M2 12h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  },
  {
    id: "image", label: "Image",
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><circle cx="5.5" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.2"/><path d="M1.5 10.5l3.5-3 3 2.5 2-2 3 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  },
  {
    id: "video", label: "Video",
    icon: <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="1" y="3" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><path d="M10 6l4-2v7l-4-2V6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>,
  },
];

function ModeTab({ mode, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 7,
      background: active ? T.surface : "none",
      border: active ? `1px solid ${T.border}` : "1px solid transparent",
      borderRadius: 8, padding: "7px 14px",
      color: active ? T.text : T.muted,
      fontSize: 13, fontWeight: active ? 600 : 400,
      cursor: "pointer", transition: "all 0.15s",
      boxShadow: active ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
    }}>
      {mode.icon}
      {mode.label}
    </button>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function Veritas() {
  // nav
  const [navTab, setNavTab] = useState("check");
  // input mode
  const [mode, setMode] = useState("text");
  // text
  const [text, setText] = useState("");
  // image
  const [imgFile, setImgFile]       = useState(null);
  const [imgPreview, setImgPreview] = useState(null);
  const [imgCaption, setImgCaption] = useState("");
  // video
  const [vidFile, setVidFile]     = useState(null);
  const [vidFrame, setVidFrame]   = useState(null); // base64
  // shared
  const [loading, setLoading] = useState(false);
  const [step, setStep]       = useState("");
  const [result, setResult]   = useState(null);
  const [flags, setFlags]     = useState([]);
  const [error, setError]     = useState("");
  const [history, setHist]    = useState([]);
  const [copied, setCopied]   = useState(false);
  const resultRef = useRef(null);

  // ── Image file picked ──
  async function handleImageFile(file) {
    if (!file.type.startsWith("image/")) { setError("Please select an image file (JPG, PNG, WebP, GIF)."); return; }
    if (file.size > MAX_IMAGE_MB * 1024 * 1024) { setError(`Image must be under ${MAX_IMAGE_MB} MB.`); return; }
    setError("");
    setImgFile(file);
    setImgPreview(URL.createObjectURL(file));
    setResult(null);
  }

  // ── Video file picked ──
  async function handleVideoFile(file) {
    if (!file.type.startsWith("video/")) { setError("Please select a video file (MP4, WebM, MOV)."); return; }
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) { setError(`Video must be under ${MAX_VIDEO_MB} MB.`); return; }
    setError("");
    setVidFile(file);
    setVidFrame(null);
    setResult(null);
    try {
      const frame = await extractVideoFrame(file);
      setVidFrame(frame);
    } catch {
      setError("Could not extract a frame from this video. Please try another file.");
    }
  }

  // ── Verify ──
  async function handleVerify() {
    setError(""); setResult(null);

    if (mode === "text") {
      const t = text.trim();
      if (t.length < 10) { setError("Please enter at least one sentence to analyse."); return; }
      setLoading(true);
      setFlags(PATTERNS.filter(p => p.re.test(t)));
      for (const s of TEXT_STEPS) { setStep(s); await sleep(550); }
      try {
        const data = await analyseText(t);
        setResult(data);
        addHistory({ snippet: t.slice(0, 90), type: "text", data });
      } catch { setError("Analysis failed. Please check your connection and try again."); }

    } else if (mode === "image") {
      if (!imgFile) { setError("Please select or drop an image first."); return; }
      setLoading(true); setFlags([]);
      for (const s of IMAGE_STEPS) { setStep(s); await sleep(550); }
      try {
        const b64  = await fileToBase64(imgFile);
        const data = await analyseImage(b64, imgFile.type, imgCaption);
        setResult(data);
        addHistory({ snippet: imgFile.name, type: "image", data });
      } catch { setError("Image analysis failed. Please try again."); }

    } else if (mode === "video") {
      if (!vidFile)  { setError("Please select or drop a video first."); return; }
      if (!vidFrame) { setError("Still extracting frame — please wait a moment."); return; }
      setLoading(true); setFlags([]);
      for (const s of VIDEO_STEPS) { setStep(s); await sleep(550); }
      try {
        const data = await analyseImage(vidFrame, "image/jpeg", `This is a frame extracted from a video file named: ${vidFile.name}`);
        setResult(data);
        addHistory({ snippet: vidFile.name, type: "video", data });
      } catch { setError("Video analysis failed. Please try again."); }
    }

    setLoading(false);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }

  function addHistory({ snippet, type, data }) {
    setHist(h => [{
      id: Date.now(), snippet, type,
      verdict: data.overallVerdict,
      score: data.confidenceScore,
      data,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }, ...h.slice(0, 9)]);
  }

  function handleCopy() {
    if (!result) return;
    const v = VERDICTS[result.overallVerdict];
    navigator.clipboard.writeText(`Veritas Fact Check\n\nVerdict: ${v.label}\nConfidence: ${result.confidenceScore}%\n\n${result.summary}\n\nVerified by Veritas`);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  function handleReset() {
    setResult(null); setText(""); setImgFile(null); setImgPreview(null); setImgCaption(""); setVidFile(null); setVidFrame(null); setFlags([]); setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const canVerify = !loading && (
    (mode === "text"  && text.trim().length >= 10) ||
    (mode === "image" && !!imgFile) ||
    (mode === "video" && !!vidFile && !!vidFrame)
  );

  const TYPE_ICON = { text: "T", image: "IMG", video: "VID" };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: T.fontBody, color: T.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes rise { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes spin { to { transform:rotate(360deg); } }
        @keyframes fade { from { opacity:0; } to { opacity:1; } }
        textarea:focus, input:focus { outline: none; }
        button { font-family: inherit; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${T.borderMd}; border-radius: 10px; }
      `}</style>

      {/* ── Nav ── */}
      <header style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 24px", height: 58, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: T.text, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5L2 5v6l6 3.5L14 11V5L8 1.5z" stroke="white" strokeWidth="1.25" strokeLinejoin="round" />
                <path d="M8 1.5v13M2 5l6 3.5L14 5" stroke="white" strokeWidth="1.25" strokeLinejoin="round" />
              </svg>
            </div>
            <span style={{ fontFamily: T.fontDisplay, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>Veritas</span>
          </div>
          <nav style={{ display: "flex", gap: 2 }}>
            {[{ id: "check", label: "Check" }, { id: "history", label: `History${history.length ? ` · ${history.length}` : ""}` }, { id: "about", label: "About" }].map(t => (
              <button key={t.id} onClick={() => setNavTab(t.id)} style={{
                background: navTab === t.id ? T.bg : "none", border: "none", borderRadius: 7,
                padding: "6px 14px", cursor: "pointer", fontSize: 13,
                fontWeight: navTab === t.id ? 600 : 400,
                color: navTab === t.id ? T.text : T.muted, transition: "all 0.15s",
              }}>{t.label}</button>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 860, margin: "0 auto", padding: "48px 24px 96px" }}>

        {/* ══ CHECK TAB ══ */}
        {navTab === "check" && (
          <div style={{ animation: "fade 0.3s ease" }}>

            {/* Hero */}
            {!result && (
              <div style={{ marginBottom: 36, maxWidth: 600 }}>
                <h1 style={{ fontFamily: T.fontDisplay, fontSize: "clamp(30px, 5vw, 44px)", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.03em", marginBottom: 14, color: T.text }}>
                  Verify before<br />you share.
                </h1>
                <p style={{ fontSize: 16, color: T.muted, lineHeight: 1.65 }}>
                  Paste a message, upload an image, or submit a video. Veritas extracts key claims, cross-references authoritative sources, and returns a clear verdict.
                </p>
              </div>
            )}

            {/* Mode selector */}
            {!result && (
              <div style={{ display: "flex", gap: 6, marginBottom: 16, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 4, width: "fit-content" }}>
                {MODES.map(m => <ModeTab key={m.id} mode={m} active={mode === m.id} onClick={() => { setMode(m.id); setError(""); setResult(null); }} />)}
              </div>
            )}

            {/* ── TEXT MODE ── */}
            {mode === "text" && !result && (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value.slice(0, 4000))}
                  placeholder="Paste a WhatsApp forward, news headline, or any claim here…"
                  rows={6}
                  style={{ width: "100%", border: "none", resize: "vertical", padding: "20px 20px 16px", fontSize: 15, fontFamily: T.fontBody, color: T.text, background: "transparent", lineHeight: 1.7 }}
                />
                <div style={{ padding: "12px 16px", borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: T.bg, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={async () => { try { setText((await navigator.clipboard.readText()).slice(0, 4000)); } catch {} }} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, color: T.muted, fontWeight: 500 }}>Paste</button>
                    <button onClick={() => { setText(""); setError(""); }} style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, color: T.muted, fontWeight: 500 }}>Clear</button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 12, color: T.faint, fontFamily: T.fontMono }}>{text.length}/4000</span>
                    <button onClick={handleVerify} disabled={!canVerify} style={{ background: canVerify ? T.text : T.border, color: canVerify ? "#fff" : T.faint, border: "none", borderRadius: 8, padding: "9px 20px", fontSize: 14, fontWeight: 600, cursor: canVerify ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s" }}>
                      {loading ? <><span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin 0.75s linear infinite" }} />Analysing</> : "Verify with Veritas"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── IMAGE MODE ── */}
            {mode === "image" && !result && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
                {!imgFile
                  ? <MediaDropZone onFile={handleImageFile} accept={ACCEPT_IMAGE} label="Drop an image or click to browse" hint="Supports JPG, PNG, WebP, GIF · Max 4 MB" icon="🖼" />
                  : <ImagePreview file={imgFile} previewUrl={imgPreview} caption={imgCaption} onCaption={setImgCaption} onRemove={() => { setImgFile(null); setImgPreview(null); setImgCaption(""); setResult(null); }} />
                }
                {imgFile && (
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button onClick={handleVerify} disabled={!canVerify} style={{ background: canVerify ? T.text : T.border, color: canVerify ? "#fff" : T.faint, border: "none", borderRadius: 8, padding: "9px 22px", fontSize: 14, fontWeight: 600, cursor: canVerify ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s" }}>
                      {loading ? <><span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin 0.75s linear infinite" }} />Analysing</> : "Verify Image"}
                    </button>
                  </div>
                )}
                <div style={{ background: T.accentBg, border: `1px solid #C7D9F8`, borderRadius: 10, padding: "12px 16px" }}>
                  <p style={{ fontSize: 13, color: T.accent, lineHeight: 1.6 }}>
                    <strong>How image verification works:</strong> Veritas uses AI vision to read all text visible in the image, identify visual claims, detect manipulated or misleading visuals, and cross-reference against known facts.
                  </p>
                </div>
              </div>
            )}

            {/* ── VIDEO MODE ── */}
            {mode === "video" && !result && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
                {!vidFile
                  ? <MediaDropZone onFile={handleVideoFile} accept={ACCEPT_VIDEO} label="Drop a video or click to browse" hint="Supports MP4, WebM, MOV · Max 50 MB" icon="🎬" />
                  : <VideoPreview file={vidFile} frameUrl={vidFrame} onRemove={() => { setVidFile(null); setVidFrame(null); setResult(null); }} />
                }
                {vidFile && (
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button onClick={handleVerify} disabled={!canVerify} style={{ background: canVerify ? T.text : T.border, color: canVerify ? "#fff" : T.faint, border: "none", borderRadius: 8, padding: "9px 22px", fontSize: 14, fontWeight: 600, cursor: canVerify ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 8, transition: "all 0.2s" }}>
                      {loading ? <><span style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin 0.75s linear infinite" }} />Analysing</> : "Verify Video"}
                    </button>
                  </div>
                )}
                <div style={{ background: T.accentBg, border: `1px solid #C7D9F8`, borderRadius: 10, padding: "12px 16px" }}>
                  <p style={{ fontSize: 13, color: T.accent, lineHeight: 1.6 }}>
                    <strong>How video verification works:</strong> Veritas extracts a representative frame from your video and analyses it using AI vision — reading on-screen text, headlines, captions, and visual context to evaluate factual claims.
                  </p>
                </div>
              </div>
            )}

            {/* Error */}
            {error && <div style={{ background: T.false.bg, border: `1px solid ${T.false.border}`, borderRadius: 9, padding: "12px 16px", color: T.false.fg, fontSize: 14, marginBottom: 16 }}>{error}</div>}

            {/* Loading */}
            {loading && <LoadingPanel step={step} />}

            {/* Results */}
            {result && !loading && (
              <div ref={resultRef}>
                {/* Show what was analysed */}
                {(imgFile || vidFile) && (
                  <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
                    {imgFile && <img src={imgPreview} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}` }} />}
                    {vidFile && vidFrame && <img src={`data:image/jpeg;base64,${vidFrame}`} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.border}` }} />}
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{imgFile?.name || vidFile?.name}</p>
                      <p style={{ fontSize: 12, color: T.faint }}>{mode === "video" ? "Video — analysed via extracted frame" : "Image analysis"}</p>
                    </div>
                  </div>
                )}
                <ResultsPanel result={result} flags={flags} onCopy={handleCopy} copied={copied} onReset={handleReset} />
              </div>
            )}

            {/* Feature pills */}
            {!result && !loading && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 28 }}>
                {["Claim extraction", "Image OCR", "Video frame analysis", "Source verification", "Confidence scoring", "Rumour pattern detection"].map(f => (
                  <span key={f} style={{ fontSize: 12, color: T.muted, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 99, padding: "5px 12px" }}>{f}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══ HISTORY TAB ══ */}
        {navTab === "history" && (
          <div style={{ animation: "fade 0.3s ease" }}>
            <div style={{ marginBottom: 28 }}>
              <h2 style={{ fontFamily: T.fontDisplay, fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>Check History</h2>
              <p style={{ fontSize: 14, color: T.muted }}>Session history only — cleared on page refresh.</p>
            </div>
            {history.length === 0
              ? <div style={{ background: T.surface, border: `1px dashed ${T.border}`, borderRadius: 12, padding: "56px 24px", textAlign: "center" }}><p style={{ fontSize: 14, color: T.faint }}>No checks yet. Go verify something.</p></div>
              : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
                  {history.map((item, i) => {
                    const v = VERDICTS[item.verdict] || VERDICTS.UNVERIFIED;
                    return (
                      <div key={item.id}
                        onClick={() => { setResult(item.data); setNavTab("check"); setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 200); }}
                        onMouseOver={e => e.currentTarget.style.background = T.bg}
                        onMouseOut={e  => e.currentTarget.style.background = T.surface}
                        style={{ background: T.surface, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", borderBottom: i < history.length - 1 ? `1px solid ${T.border}` : "none", transition: "background 0.15s" }}
                      >
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: v.dot, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontFamily: T.fontMono, color: T.faint, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>{TYPE_ICON[item.type]}</span>
                        <span style={{ flex: 1, fontSize: 14, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.snippet}…</span>
                        <Chip verdict={item.verdict} />
                        <span style={{ fontSize: 12, color: T.faint, fontFamily: T.fontMono, flexShrink: 0 }}>{item.score}%</span>
                        <span style={{ fontSize: 12, color: T.faint, flexShrink: 0 }}>{item.time}</span>
                      </div>
                    );
                  })}
                </div>
              )
            }
          </div>
        )}

        {/* ══ ABOUT TAB ══ */}
        {navTab === "about" && (
          <div style={{ animation: "fade 0.3s ease", maxWidth: 600 }}>
            <h2 style={{ fontFamily: T.fontDisplay, fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 24 }}>About Veritas</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 0, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
              {[
                { label: "What it does", body: "Veritas analyses text, images, and video frames for factual accuracy. It extracts verifiable claims, cross-references them against authoritative sources, and returns a verdict with a confidence score." },
                { label: "Text verification", body: "Paste any message or claim. The AI identifies key factual statements and evaluates each against known information from Reuters, AP, BBC, WHO, CDC, Snopes, and PolitiFact." },
                { label: "Image verification", body: "Upload a screenshot or photo. Veritas reads all visible text using AI vision, identifies factual claims within the image, and evaluates their accuracy." },
                { label: "Video verification", body: "Submit a video file. Veritas extracts a representative frame, reads on-screen text and visual context, then evaluates any claims found. Note: only a single frame is analysed — continuous video analysis is not currently supported." },
                { label: "Verdict types", body: "True — supported by credible evidence. False — contradicted by credible evidence. Misleading — contains partial truths in a deceptive framing. Unverified — insufficient evidence to confirm or deny." },
                { label: "Limitations", body: "AI analysis is not infallible. Veritas is a tool to assist critical thinking, not replace it. For important decisions, always consult multiple primary sources directly." },
              ].map((item, i, arr) => (
                <div key={i} style={{ padding: "20px 22px", background: T.surface, borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : "none" }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: T.faint, letterSpacing: "0.09em", fontFamily: T.fontMono, marginBottom: 8 }}>{item.label.toUpperCase()}</p>
                  <p style={{ fontSize: 14, color: T.muted, lineHeight: 1.75 }}>{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer style={{ borderTop: `1px solid ${T.border}`, padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <span style={{ fontFamily: T.fontDisplay, fontWeight: 700, fontSize: 14, color: T.text }}>Veritas</span>
        <span style={{ color: T.faint, fontSize: 13 }}>· AI-powered fact-checking · Always verify from primary sources</span>
      </footer>
    </div>
  );
}