import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import path from "node:path";
import { readFileSync } from "node:fs";

const authDir = process.env.WA_AUTH_DIR || path.join(process.cwd(), "auth_info_baileys");
let sock: ReturnType<typeof makeWASocket> | null = null;

function toJid(number: string): string {
  // digits only, then @s.whatsapp.net
  return `${number.replace(/\D/g, "")}@s.whatsapp.net`;
}

export async function connectWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sock = makeWASocket({ auth: state });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("SCAN THIS QR WITH WHATSAPP:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") console.log("whatsapp connected");
    if (connection === "close") {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectWhatsApp();
    }
  });
  await new Promise((r) => setTimeout(r, 2000));
}

export async function sendText(to: string, text: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp not connected");
  await sock.sendMessage(toJid(to), { text });
}

export async function sendImage(to: string, filePath: string, caption?: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp not connected");
  await sock.sendMessage(toJid(to), {
    image: readFileSync(filePath),
    caption,
  });
}

export async function sendDocument(to: string, filePath: string, filename: string, mimetype: string): Promise<void> {
  if (!sock) throw new Error("WhatsApp not connected");
  await sock.sendMessage(toJid(to), {
    document: readFileSync(filePath),
    fileName: filename,
    mimetype,
  });
}