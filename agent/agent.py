"""ElevateBox outbound sales agent (LiveKit Agents).

Pipeline: Soniox STT (auto language ID) -> DeepSeek LLM -> Cartesia Sonic TTS.
Sarvam STT/TTS remain in the codebase and can be re-enabled via env vars
(STT_PROVIDER=sarvam / TTS_PROVIDER=sarvam). On a dispatched job with a phone
number in metadata, the agent dials out via the configured Telnyx SIP trunk,
then runs the sales conversation.
"""
import asyncio
import os
from datetime import datetime

import httpx
from dotenv import load_dotenv

from livekit import api
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    cli,
)
from livekit.agents.beta.tools import EndCallTool
from livekit.plugins import openai, sarvam, soniox, cartesia

from prompts import SYSTEM_PROMPT
import tools
from tools import book_callback, classify_lead, fire_whatsapp

load_dotenv()

AGENT_NAME = os.getenv("LIVEKIT_AGENT_NAME", "elevatebox-sales")
TRUNK_ID = os.getenv("SIP_OUTBOUND_TRUNK_ID", "")
FROM_NUMBER = os.getenv("SIP_FROM_NUMBER", "")

# Per-language Cartesia voices (override via env if needed). Switched together
# with the language in the transcript listener.
LANG_VOICES: dict[str, str] = {
    "en": os.getenv("CARTESIA_VOICE_EN", "25d7abcb-4d6d-4aca-adce-8a1c85620c8b"),
    "ta": os.getenv("CARTESIA_VOICE_TA", "01d7796d-ac10-4ea3-8df0-3cc04f2d25ff"),
    "te": os.getenv("CARTESIA_VOICE_TE", "cf061d8b-a752-4865-81a2-57570a6e0565"),
    "hi": os.getenv("CARTESIA_VOICE_HI", "bec003e2-3cb3-429c-8468-206a393c67ad"),
}


async def _api_post(path: str, payload: dict) -> str:
    base = os.getenv("API_BASE_URL", "http://localhost:3000").rstrip("/")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"{base}/{path}",
            json=payload,
            headers={"X-API-Key": os.getenv("API_SECRET", "")},
        )
        r.raise_for_status()
        return r.text

server = AgentServer()


def _build_session() -> AgentSession:
    llm = openai.LLM(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        base_url="https://api.deepseek.com",
    )

    # --- STT ---
    if os.getenv("STT_PROVIDER", "soniox") == "sarvam":
        # Sarvam realtime streaming STT (fallback). `stream_type="fast"` is the
        # fastest server latency profile, `mode="codemix"` keeps code-switching,
        # `language="auto"` follows en->ta->en switches live. Server-side VAD
        # emits partial + final transcripts promptly.
        stt = sarvam.STTRealtime(
            api_key=os.getenv("SARVAM_API_KEY"),
            language="auto",
            stream_type="fast",
            mode="codemix",
            endpointing="vad",
            vad_min_silence_ms=250,
            vad_min_speech_ms=150,
        )
    else:
        # Soniox real-time STT (default): auto language identification (handles
        # en/ta/te/hi code-switching with no hints), plus aggressive endpoint
        # tuning so the turn commits as soon as the caller pauses.
        stt = soniox.STT(
            params=soniox.STTOptions(
                model="stt-rt-v5",
                enable_language_identification=True,
                max_endpoint_delay_ms=500,
                endpoint_latency_adjustment_level=3,
            ),
        )

    # --- TTS ---
    if os.getenv("TTS_PROVIDER", "cartesia") == "sarvam":
        # Sarvam Bulbul TTS (fallback). Lower min_buffer_size/max_chunk_length
        # so audio starts sooner (lower TTFB).
        tts = sarvam.TTS(
            api_key=os.getenv("SARVAM_API_KEY"),
            speaker=os.getenv("SARVAM_SPEAKER", "shreya"),
            target_language_code="en-IN",
            min_buffer_size=30,
            max_chunk_length=100,
        )
    else:
        # Cartesia Sonic 3.5 (default): sub-90ms latency, natural expressive
        # voice. Each language uses its own native voice, switched per-utterance
        # via update_options in the transcript listener (voice switching is
        # parameter-only — the WebSocket stays open, so no extra latency).
        tts = cartesia.TTS(
            api_key=os.getenv("CARTESIA_API_KEY"),
            model="sonic-3.5",
            voice=os.getenv("CARTESIA_VOICE_EN", "25d7abcb-4d6d-4aca-adce-8a1c85620c8b"),
            language="en",
        )

    # Safe endpointing: agent starts replying sooner, but the min delay still
    # gives the caller room to pause mid-sentence without being cut off.
    # turn_detection="stt" uses the STT's own endpoint detection to end the
    # turn (single authority — no second VAD + endpointing stack on top).
    # Preemptive generation runs the LLM (and TTS) while the caller is still
    # finishing their sentence, so the reply feels instant.
    return AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        turn_handling={
            "turn_detection": "stt",
            "endpointing": {"mode": "dynamic", "min_delay": 0.2, "max_delay": 1.0},
            "preemptive_generation": {"enabled": True, "preemptive_tts": True},
        },
    )


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    # Outbound dial: the number to call arrives in dispatch metadata.
    dial = {}
    if ctx.job and ctx.job.metadata:
        import json
        try:
            dial = json.loads(ctx.job.metadata)
        except json.JSONDecodeError:
            dial = {}

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    instructions = SYSTEM_PROMPT.format(
        current_time=now,
        from_number=FROM_NUMBER or "unknown",
    )
    agent = Agent(
        instructions=instructions,
        tools=[fire_whatsapp, book_callback, classify_lead, EndCallTool()],
    )

    # Tag tool calls with this room so the dashboard can group them per call,
    # and with the dialed number so WhatsApp/callbacks reach the caller.
    tools.ROOM = ctx.room.name
    tools.TO_NUMBER = dial.get("phone_number", "")

    async def report_event(kind: str, detail: str = "", status: str = "") -> None:
        try:
            await _api_post("api/call/event", {"room": ctx.room.name, "kind": kind, "detail": detail, "status": status})
        except Exception:
            pass

    # Fire the event without blocking the greeting (the HTTP call to the API
    # must not delay the agent's first words).
    def report_event_async(kind: str, detail: str = "", status: str = "") -> None:
        asyncio.create_task(report_event(kind, detail, status))

    # On shutdown — whether the callee hangs up, the agent calls end_call, or a
    # failure occurs — delete the room so the SIP call is actually disconnected.
    # (EndCallTool also deletes the room, but only via the session-close path;
    # this guarantees the hangup in every case. Deleting the room disconnects
    # all remote participants, including the Telnyx SIP caller.)
    async def _on_shutdown() -> None:
        await report_event("ended", "Call ended", "ended")
        try:
            await ctx.delete_room()
        except Exception as e:
            print(f"room deletion failed: {e}")

    ctx.add_shutdown_callback(_on_shutdown)

    # Start the session FIRST so the agent's RoomIO/audio connection is active
    # in the room immediately. (Starting it only after the dial blocks on
    # wait_until_answered -> LiveKit's "no RoomIO started within 10s" warning,
    # and the callee hears silence because no agent audio is in the room.)
    session = _build_session()
    await session.start(agent=agent, room=ctx.room)

    # Prewarm the TTS/STT connections NOW, before dialing. AgentSession only
    # prewarms the LLM; the Sarvam TTS pool is cold on the first call, so the
    # greeting's first synthesis would wait on a fresh WebSocket handshake
    # (producing silence on call #1). Warming it during the ring fixes that.
    try:
        if session.tts:
            session.tts.prewarm()
        if session.stt:
            session.stt.prewarm()
    except Exception as e:
        print(f"prewarm failed: {e}")

    # Force the TTS connection + model fully warm with a throwaway synthesis
    # (fires during the ring; the greeting then plays on a hot connection).
    try:
        if session.tts:
            async for _ in session.tts.synthesize("hello"):
                pass
    except Exception as e:
        print(f"tts warmup failed: {e}")

    # Stream what the customer actually says into the dashboard timeline so the
    # "How it decided" panel shows the real conversation, not just lifecycle
    # events. Also lock the TTS to the customer's CURRENT language on every
    # turn — switching voices as the customer switches (the fixed
    # target_language_code="unknown" makes the TTS fall back to a default
    # language, which also mispronounces amounts in e.g. Hindi).
    detected_language: dict[str, str] = {}

    async def _on_user_transcribed_async(ev) -> None:
        if not ev.is_final or not ev.transcript.strip():
            return
        text = ev.transcript.strip()
        await report_event("heard", text)
        if ev.language:
            detected_language[ev.language] = ev.language
            try:
                if session.tts:
                    # Soniox returns 2-letter codes (en/hi/ta/te); Sarvam returns
                    # BCP-47 (en-IN). Normalize to a 2-letter code.
                    lang = str(ev.language).split("-")[0]
                    if os.getenv("TTS_PROVIDER", "cartesia") == "cartesia":
                        # Switch voice AND language together so each language
                        # gets its native voice.
                        voice = LANG_VOICES.get(lang)
                        if voice:
                            session.tts.update_options(language=lang, voice=voice)
                        else:
                            session.tts.update_options(language=lang)
                    else:
                        session.tts.update_options(target_language_code=ev.language)
                await _api_post(
                    "api/call/event",
                    {"room": ctx.room.name, "language": ev.language},
                )
                await report_event("language", ev.language)
            except Exception:
                pass

    # .on() only accepts synchronous callbacks — spawn the async work instead.
    def _on_user_transcribed(ev) -> None:
        asyncio.create_task(_on_user_transcribed_async(ev))

    session.on("user_input_transcribed", _on_user_transcribed)

    # When the call ends, send the post-call follow-up WhatsApp with the real
    # conversation context + resume + architecture image. Transcript comes from
    # the session's own history, so it reflects exactly what was said. Triggered
    # from the awaited shutdown callback (not a fire-and-forget task) so it
    # reliably completes before the job process exits.
    followup_sent = False

    async def _send_followup() -> None:
        nonlocal followup_sent
        if followup_sent:
            return
        followup_sent = True
        try:
            msgs = []
            has_user_speech = False
            for m in session.history.messages():
                content = m.content
                if isinstance(content, str):
                    text = content
                else:
                    text = " ".join(
                        c if isinstance(c, str) else "" for c in content
                    )
                text = text.strip()
                if not text:
                    continue
                if m.role == "user":
                    has_user_speech = True
                if m.role in ("user", "assistant"):
                    msgs.append(f"{m.role}: {text}")
            # If the caller picked up but never spoke, there's no context to
            # follow up on — sending anything would be a hollow template.
            if not has_user_speech:
                print("no customer speech — skipping follow-up")
                return
            transcript = "\n".join(msgs)[:8000]
            raw_lang = list(detected_language)[-1] if detected_language else "en"
            # Soniox gives 2-letter codes (en/hi/ta/te); the follow-up composer
            # reads better with a full language name.
            language = {
                "en": "English",
                "hi": "Hindi",
                "ta": "Tamil",
                "te": "Telugu",
            }.get(raw_lang.split("-")[0], "English")
            await _api_post(
                "api/followup",
                {
                    "room": ctx.room.name,
                    "transcript": transcript,
                    "language": language,
                    "to": dial.get("phone_number", ""),
                },
            )
            print("follow-up sent")
        except Exception as e:
            print(f"follow-up failed: {e}")

    # Send the follow-up on job shutdown (awaited by the shutdown machinery so
    # it completes before the process exits). One-shot via the flag.
    ctx.add_shutdown_callback(_send_followup)

    if dial.get("phone_number"):
        # Pre-link audio to the expected SIP participant identity (matches
        # LiveKit's working outbound examples) so frames route once they answer.
        if session.room_io:
            session.room_io.set_participant("customer")
        try:
            await ctx.api.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    room_name=ctx.room.name,
                    sip_trunk_id=dial.get("sip_trunk_id", TRUNK_ID),
                    sip_call_to=dial["phone_number"],
                    participant_identity="customer",
                    wait_until_answered=True,
                )
            )
            print("call picked up")
            report_event_async("answered", "Customer picked up", "active")
        except api.SipCallError as e:
            # e.sip_status_code / e.sip_status carry the upstream carrier status
            print(f"call failed: {e.sip_status_code} {e.sip_status}")
            await report_event("failed", f"{e.sip_status_code} {e.sip_status}", "failed")
            ctx.shutdown()
            return
        except asyncio.TimeoutError:
            print("customer did not answer in time")
            await report_event("failed", "no answer", "failed")
            ctx.shutdown()
            return
        # Confirm the callee joined the room before greeting.
        await ctx.wait_for_participant(identity="customer")

    # Greet via TTS only (session.say skips the LLM round-trip) so the agent
    # speaks within a beat of the call connecting — the caller shouldn't wait
    # ~2s for an LLM call before hearing anything.
    await session.say(
        "Hello! This is Anu calling from ElevateBox. How are you doing today?"
    )


if __name__ == "__main__":
    cli.run_app(server)