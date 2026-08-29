import express from "express";
import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { startCall } from "./livekit.js";
import {
	connectWhatsApp,
	sendText,
	sendImage,
	sendDocument,
} from "./whatsapp.js";
import { insertLead, upsertCallback, upsertCall, updateCallStatus, updateCallLanguage, addEvent, listCalls, listEvents, listLeads, pendingCallbacks } from "./db.js";
import { startScheduler, resolveTime } from "./scheduler.js";

loadEnv({ path: path.resolve(process.cwd(), "..", ".env") });

const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve(process.cwd(), "..", "assets");
const DASHBOARD_DIST = process.env.DASHBOARD_DIST || path.resolve(process.cwd(), "..", "dashboard", "dist");

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET;
const TARGET = process.env.TARGET_NUMBER || "";
const TO = process.env.WHATSAPP_TO || "91886664337";

// Simple API-key auth for trigger endpoints
function requireKey(
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) {
	if (req.get("X-API-Key") !== API_SECRET)
		return res.status(401).json({ error: "unauthorized" });
	next();
}

async function composeFollowup(
	transcript: string,
	language: string,
): Promise<string> {
	// Only write a follow-up when the customer actually said something. If the
	// caller never spoke (picked up and went silent), the "transcript" is just
	// the agent's greeting — there's nothing to reference, so return an honest
	// simple message instead of letting the LLM reply "please send the transcript".
	const clean = transcript.trim();
	const hasCustomerSpeech = /(^|\n)user:/i.test(clean);
	if (!hasCustomerSpeech || clean.length < 40) {
		return (
			`Hi! This is Anu from ElevateBox. Thanks for taking my call just now — ` +
			`sorry we didn't get to chat properly. Whenever you're free, reply here ` +
			`or call me at ${process.env.YOUR_NUMBER || ""}. Happy to help with your ` +
			`e-commerce website. Have a great day!`
		);
	}

	const res = await fetch("https://api.deepseek.com/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
		},
		body: JSON.stringify({
			model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
			messages: [
				{
					role: "system",
					content:
						"You are Anu from ElevateBox, a web development studio in Hyderabad. " +
						"Write a short, warm WhatsApp follow-up to a customer after a sales call. " +
						"ABSOLUTE RULES:\n" +
						"- NEVER use placeholders, brackets, or tokens like [Name], [Your Name], " +
						"[problem], [date], [X]. No square brackets anywhere in the message.\n" +
						"- ONLY reference facts that actually appear in the conversation transcript. " +
						"Quote 1-2 specific things the customer said (their business, products, budget, " +
						"timeline, features).\n" +
						"- Read like a real person wrote it after a real call — not a template, not a log.\n" +
						`- Write entirely in ${language}.\n` +
						"- Sign off with your name (Anu) and this phone number: " +
						`${process.env.YOUR_NUMBER || ""}. End with a clear call to action.\n` +
						"- Max 120 words.",
				},
				{ role: "user", content: clean },
			],
			temperature: 0.5,
		}),
	});
	const data = await res.json();
	let text = data.choices?.[0]?.message?.content?.trim() || "";
	// Safety nets: if the model still emitted placeholders, OR it produced
	// meta-output (asking for the transcript/details) instead of an actual
	// follow-up, fall back to the honest simple message rather than sending
	// brackets or a "please send me more info" reply to the customer.
	const isMetaOutput =
		/\[[^\]]*\]/.test(text) ||
		/(paste|send|provide|share).{0,20}(transcript|details|context)/i.test(text) ||
		/(please|kindly).{0,20}(paste|provide|share)/i.test(text) ||
		/i (can't|cannot|need|require).{0,20}(transcript|details)/i.test(text);
	if (isMetaOutput || !text) {
		text =
			`Hi! This is Anu from ElevateBox. Thanks again for our chat — I've noted what ` +
			`you shared and I'm ready to help whenever you are. Reply here or call me at ` +
			`${process.env.YOUR_NUMBER || ""}. Have a great day!`;
	}
	return text;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Dashboard config: default dial + WhatsApp numbers so the UI can prefill.
app.get("/api/config", (_req, res) =>
	res.json({ target_number: TARGET, whatsapp_to: TO, your_number: process.env.YOUR_NUMBER || "" }),
);

// Trigger an outbound sales call. Optional `to` overrides the default target;
// the agent dials it and all WhatsApp actions target the same number.
app.post("/api/call/start", requireKey, async (req, res) => {
	try {
		const to = (req.body.to || TARGET || "").toString().replace(/[^\d+]/g, "");
		if (!to) return res.status(400).json({ error: "no number to call" });
		const room = await startCall(to);
		upsertCall(room, to);
		addEvent(room, "dial", "Calling " + to);
		res.json({ room, to });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// Send a WhatsApp text (called by the agent's fire_whatsapp tool, mid-call)
app.post("/api/whatsapp/send", requireKey, async (req, res) => {
	try {
		const room = req.body.room || "";
		if (room) upsertCall(room);
		await sendText(req.body.to || TO, req.body.text);
		if (room) addEvent(room, "whatsapp", req.body.text || "");
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// Store a callback request (agent's book_callback tool). Replaces any pending
// callback already booked in this conversation, per the customer's latest ask.
// The natural-language time is resolved ONCE here into an absolute timestamp;
// the scheduler only compares against it, so "in 5 minutes" fires in 5 minutes.
app.post("/api/callbacks", requireKey, async (req, res) => {
	const room = req.body.room || "";
	const when = req.body.when || "";
	let whenAt: string | null = null;
	try {
		whenAt = await resolveTime(when, new Date());
	} catch (e) {
		console.error("callback time resolution failed", e);
	}
	upsertCallback(when, req.body.to || TO, whenAt, room || undefined);
	if (room) {
		upsertCall(room);
		addEvent(room, "callback", when);
	}
	res.json({ ok: true, when_at: whenAt });
});

// Store a lead classification (agent's classify_lead tool)
app.post("/api/leads", requireKey, async (req, res) => {
	const room = req.body.room || "";
	insertLead(req.body.level, req.body.notes || "");
	if (room) {
		upsertCall(room);
		if (req.body.language) updateCallLanguage(room, req.body.language);
		addEvent(room, "classify", `${req.body.level}: ${req.body.notes || ""}`);
	}
	res.json({ ok: true });
});

// Agent reports call lifecycle events
app.post("/api/call/event", requireKey, async (req, res) => {
	const { room, kind, detail, status, language } = req.body;
	if (!room) return res.status(400).json({ error: "room required" });
	upsertCall(room);
	if (status) updateCallStatus(room, status);
	if (language) updateCallLanguage(room, language);
	if (kind) addEvent(room, kind, detail || "");
	res.json({ ok: true });
});

// Post-call: send follow-up WhatsApp with context + resume + architecture image
app.post("/api/followup", requireKey, async (req, res) => {
	try {
		const { language = "en", transcript = "", room = "" } = req.body;
		const to = req.body.to || TO;
		const text = await composeFollowup(transcript, language);
		await sendText(to, text);
		const img = path.join(ASSETS_DIR, "architecture.png");
		const resume = path.join(ASSETS_DIR, "resume.pdf");
		if (existsSync(img)) await sendImage(to, img, "How I built this");
		if (existsSync(resume)) await sendDocument(to, resume, "resume.pdf", "application/pdf");
		if (room) {
			upsertCall(room);
			updateCallLanguage(room, language);
			addEvent(room, "followup", text);
		}
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: String(e) });
	}
});

// ---- dashboard (public read) ----
app.get("/api/calls", (_req, res) => res.json(listCalls()));
app.get("/api/calls/:room/events", (req, res) => res.json(listEvents(req.params.room)));
app.get("/api/leads", (_req, res) => res.json(listLeads()));
app.get("/api/callbacks", (_req, res) => res.json(pendingCallbacks()));
app.get("/api/stats", (_req, res) => {
	const calls = listCalls(1000);
	const leads = listLeads() as { level: string }[];
	const hot = leads.filter((l) => l.level === "HOT").length;
	const warm = leads.filter((l) => l.level === "WARM").length;
	const cold = leads.filter((l) => l.level === "COLD").length;
	const pending = pendingCallbacks().length;
	res.json({ total_calls: calls.length, hot, warm, cold, pending_callbacks: pending });
});

// ---- dashboard static (built React app, if present) ----
if (existsSync(DASHBOARD_DIST)) {
	app.use(express.static(DASHBOARD_DIST));
	app.get(/^\/(?!api\/|health).*/, (_req, res) => res.sendFile(path.join(DASHBOARD_DIST, "index.html")));
}

const port = Number(process.env.PORT || 3000);
app.listen(port, async () => {
	console.log(`api on :${port}`);
	try {
		await connectWhatsApp();
	} catch (e) {
		console.error("whatsapp failed (scan QR):", e);
	}
	startScheduler();
});
