import { LiveKitAPI } from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: path.resolve(process.cwd(), "..", ".env") });

let lk: LiveKitAPI | null = null;
function api(): LiveKitAPI {
  if (!lk) {
    lk = new LiveKitAPI({
      host: process.env.LIVEKIT_URL || "",
      apiKey: process.env.LIVEKIT_API_KEY,
      secret: process.env.LIVEKIT_API_SECRET,
    });
  }
  return lk;
}

/**
 * Start an outbound sales call.
 * Creates an agent dispatch with the target phone + trunk in metadata; the
 * agent worker dials out itself via add_sip_participant.
 */
export async function startCall(phoneNumber: string): Promise<string> {
  const room = `call-${randomUUID().slice(0, 8)}`;
  const metadata = JSON.stringify({
    phone_number: phoneNumber,
    sip_trunk_id: process.env.SIP_OUTBOUND_TRUNK_ID,
  });
  await api().agentDispatch.createDispatch(
    room,
    process.env.LIVEKIT_AGENT_NAME || "elevatebox-sales",
    { metadata },
  );
  return room;
}