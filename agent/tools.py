"""In-process function tools for the ElevateBox agent.

These forward actions to the Node API (which owns the Baileys WhatsApp session
and the database). The agent stays stateless; the API is the single owner of
side effects. This avoids a second WhatsApp connection and keeps one source of
truth for leads/callbacks.
"""
import os

import httpx
from livekit.agents import function_tool

# Set by the agent entrypoint before the session starts so tool calls can be
# grouped to a call (room) for the dashboard timeline.
ROOM: str = ""


def _api_url(path: str) -> str:
    base = os.getenv("API_BASE_URL", "http://localhost:3000").rstrip("/")
    return f"{base}/{path}"


async def _post(path: str, payload: dict) -> str:
    payload["room"] = ROOM
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            _api_url(path),
            json=payload,
            headers={"X-API-Key": os.getenv("API_SECRET", "")},
        )
        r.raise_for_status()
        return r.text


@function_tool
async def fire_whatsapp(message: str) -> str:
    """Send a WhatsApp message to the customer RIGHT NOW, mid-call.

    Call this PROACTIVELY the moment the customer shows high buying intent
    (asks for details, pricing, "how soon can you start", "send me the
    details"). Do NOT wait for the customer to ask, and do NOT wait for the
    call to end — the message must reach them while the call is still live.
    This is how HOT leads are captured.

    Args:
        message: The WhatsApp text to send to the customer.
    """
    await _post("api/whatsapp/send", {"text": message})
    return "WhatsApp message sent."


@function_tool
async def book_callback(when: str) -> str:
    """Book a callback for the customer at a specific time.

    Args:
        when: natural-language time the customer asked for (e.g. "tomorrow
              morning", "3pm today").
    """
    await _post("api/callbacks", {"when": when})
    return f"Callback booked for {when}."


@function_tool
async def classify_lead(level: str, notes: str, language: str = "") -> None:
    """Record the lead's Hot/Warm/Cold classification.

    Args:
        level: one of HOT, WARM, or COLD.
        notes: short summary of the lead (business, budget, barrier) in English.
        language: the language the customer spoke (te/hi/ta/en).
    """
    await _post("api/leads", {"level": level, "notes": notes, "language": language})
    return None