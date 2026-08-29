// Generates the architecture diagram (SVG + PNG) for the ElevateBox voice sales system.
// Clean orthogonal layout — no arrow/box collisions.
// Run: node make-arch.mjs  (writes assets/architecture.svg + assets/architecture.png)
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import path from "node:path";

const W = 1560, H = 960;

const C = {
  bg: "#0b1220",
  card: "#151e2f",
  txt: "#e6edf7",
  sub: "#9fb0c9",
  accent: "#38bdf8",
  teal: "#2dd4bf",
  green: "#4ade80",
  amber: "#fbbf24",
  purple: "#a78bfa",
  mono: "Menlo, SFMono-Regular, monospace",
};

function card(x, y, w, h, title, lines, accent) {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${C.card}" stroke="${accent}" stroke-width="1.6"/>`;
  s += `<rect x="${x}" y="${y}" width="${w}" height="4" rx="2" fill="${accent}"/>`;
  s += `<text x="${x + 18}" y="${y + 32}" font-family="${C.mono}" font-size="15" font-weight="bold" fill="${accent}">${title}</text>`;
  lines.forEach((ln, i) => {
    s += `<text x="${x + 18}" y="${y + 58 + i * 22}" font-family="${C.mono}" font-size="12.5" fill="${i === 0 ? C.txt : C.sub}">${ln}</text>`;
  });
  return s;
}

// orthogonal polyline with rounded corners + centered label
function ortho(points, label) {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  let s = `<path d="${d}" fill="none" stroke="${C.accent}" stroke-width="2" marker-end="url(#arr)"/>`;
  if (label) {
    // pick the longest segment midpoint for the label
    let best = null, blen = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[i + 1];
      const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      if (len > blen) { blen = len; best = [(x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) > Math.abs(y2 - y1)]; }
    }
    const [mx, my, horiz] = best;
    // label box
    const lw = label.length * 7.2 + 16, lh = 20;
    const bx = horiz ? mx - lw / 2 : mx - lw / 2;
    const by = horiz ? my - 22 : my - lh / 2;
    s += `<rect x="${bx}" y="${by}" width="${lw}" height="${lh}" rx="5" fill="${C.bg}" stroke="${C.accent}" stroke-width="1"/>`;
    s += `<text x="${mx}" y="${my + 1 + (horiz ? -3 : 4)}" font-family="${C.mono}" font-size="11.5" fill="${C.accent}" text-anchor="middle">${label}</text>`;
  }
  return s;
}

let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
<path d="M 0 0 L 10 5 L 0 10 z" fill="${C.accent}"/></marker></defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>`;

// title
s += `<text x="46" y="52" font-family="${C.mono}" font-size="27" font-weight="bold" fill="${C.txt}">ElevateBox — AI Voice Sales System</text>`;
s += `<text x="46" y="80" font-family="${C.mono}" font-size="13.5" fill="${C.sub}">One outbound call that sells an e-commerce site, classes the lead, and fires WhatsApp while you're still talking.</text>`;

// ===== Row 1: call path =====
s += card(40, 110, 270, 170, "CUSTOMER / MANAGER", [
  "Potential buyer",
  "+91 86866 64337",
  "Answers in Telugu, Hindi,",
  "Tamil or English",
], C.green);

s += card(420, 110, 300, 170, "TELNYX  (SIP trunk)", [
  "US +1 number = caller ID",
  "Paid account, India whitelisted",
  "Routes the call to India",
], C.amber);

s += card(820, 110, 240, 170, "LIVEKIT SIP", [
  "CreateSIPParticipant",
  "wait_until_answered",
  "Dials + joins the room",
], C.teal);

s += card(1120, 110, 400, 210, "AI AGENT  (LiveKit Cloud)", [
  "Soniox realtime STT · auto language",
  "  ID (en / hi / ta / te, code-switching)",
  "DeepSeek v4-flash LLM sells, discovers,",
  "  classifies and decides",
  "Cartesia Sonic 3.5 TTS · sub-90ms,",
  "  native voice per language",
], C.accent);

// ===== Row 2: glue + externals =====
s += card(600, 430, 440, 310, "ORCHESTRATION API  (Express/TS)", [
  "POST /api/call/start → dispatch",
  "",
  "POST /api/leads → Hot/Warm/Cold",
  "POST /api/callbacks → scheduler",
  "POST /api/whatsapp/send (mid-call)",
  "POST /api/followup → DeepSeek text",
  "  + architecture image + resume",
  "node-cron → re-dials due callbacks",
  "SQLite: leads + callbacks",
], C.green);

s += card(40, 430, 310, 310, "WHATSAPP  (Baileys)", [
  "Paired number, session persisted",
  "sendText / sendImage / sendDocument",
  "",
  "Mid-call: HOT lead → message",
  "  fires while still on the call",
  "Post-call: personalized follow-up",
  "  (text + image + resume)",
], C.amber);

s += card(1120, 430, 400, 310, "EXTERNAL SERVICES", [
  "Soniox — realtime STT",
  "  (auto language ID)",
  "",
  "Cartesia — Sonic 3.5 TTS",
  "  (native voice per language)",
  "",
  "DeepSeek — LLM + follow-up writer",
  "  + callback time resolution",
  "",
  "LiveKit Cloud — SFU + agent hosting",
  "Deployed via Coolify + Cloudflare",
], C.purple);

// ===== classification strip =====
s += `<rect x="40" y="790" width="1480" height="70" rx="12" fill="${C.card}" stroke="${C.teal}" stroke-width="1.4"/>`;
s += `<text x="60" y="818" font-family="${C.mono}" font-size="13.5" font-weight="bold" fill="${C.teal}">LEAD CLASSIFICATION</text>`;
s += `<text x="60" y="842" font-family="${C.mono}" font-size="12.5" fill="${C.sub}">HOT → WhatsApp mid-call   ·   WARM → capture the barrier, schedule a callback   ·   COLD → log it, send the brochure, move on</text>`;

// ===== arrows =====
// call path
s += ortho([[310, 195], [420, 195]], "call");
s += ortho([[720, 195], [820, 195]], "SIP");
s += ortho([[1060, 195], [1120, 195]], "dial");
// agent -> api (tools)
s += ortho([[1250, 320], [1250, 375], [660, 375], [660, 430]], "tool calls");
// api -> baileys (whatsapp send)
s += ortho([[600, 570], [350, 570]], "send");
// baileys -> customer (return)
s += ortho([[300, 430], [300, 280]], "WhatsApp");
// agent -> external (STT/TTS)
s += ortho([[1320, 320], [1320, 430]], "STT / TTS");
// api -> external (composer)
s += ortho([[1040, 650], [1120, 650]], "follow-up");

s += `</svg>`;

const outDir = path.resolve(process.cwd(), "..", "assets");
writeFileSync(path.join(outDir, "architecture.svg"), s);
await sharp(Buffer.from(s)).png().toFile(path.join(outDir, "architecture.png"));
console.log("wrote architecture.svg + architecture.png");