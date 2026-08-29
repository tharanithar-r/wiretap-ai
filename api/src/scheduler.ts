import cron from "node-cron";
import { pendingCallbacks, markCallbackDone, type CallbackRow } from "./db.js";
import { startCall } from "./livekit.js";

// Resolve a natural-language time ("tomorrow morning") to an ISO timestamp
// relative to `now` using DeepSeek. Returns null if unparseable.
export async function resolveTime(when: string, now: Date): Promise<string | null> {
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
            "Return ONLY an ISO 8601 timestamp (no prose) for the requested time, " +
            `relative to now. Now is ${now.toISOString()}. If unparseable, return the word null.`,
        },
        { role: "user", content: when },
      ],
      temperature: 0,
    }),
  });
  const data = await res.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  return out && out !== "null" ? out : null;
}

export function startScheduler(): void {
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    for (const cb of pendingCallbacks()) {
      // Compare against the absolute time resolved at booking; if it wasn't
      // resolvable, fall back to treating the row as due immediately.
      const at = cb.when_at ?? now.toISOString();
      if (new Date(at) <= now) {
        try {
          await startCall(cb.to_number);
          markCallbackDone(cb.id as number);
        } catch (e) {
          console.error("callback dial failed", e);
        }
      }
    }
  });
}