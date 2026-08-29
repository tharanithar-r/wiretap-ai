# WireTap AI - AI Voice Agent

A self-dialing, multilingual AI voice agent that runs real outbound sales calls:
it dials, qualifies leads, and acts mid-call — sending WhatsApp, booking
callbacks, and following up with full conversation context.

Built on LiveKit Agents (SIP telephony), Soniox (STT), Cartesia Sonic (TTS), a
streaming LLM, and the WhatsApp Business API via Baileys.

## Highlights

- **Self-dialing** — places outbound calls over a SIP trunk, no human on the line
- **Multilingual** — speaks Telugu, Hindi, Tamil, and English, following
  language switches mid-conversation (code-switching aware)
- **Intent-based classification** — reads Hot / Warm / Cold from indirect
  answers (e.g. "send me the details", "my brother handles the money")
- **Acts mid-call** — fires a WhatsApp message the moment high buying intent is
  detected, before the call ends
- **Callback scheduling** — converts spoken times ("call me tomorrow morning")
  into real scheduled calls, including vague phrasing
- **Smart follow-up** — after the call, sends a personalized WhatsApp quoting
  what the customer actually said, plus resume and a system architecture image
- **Live dashboard** — real-time call activity, lead board, and callbacks UI

## Architecture

```
┌─────────────┐   dispatch    ┌─────────────────────┐
│  Node API   │ ────────────► │  LiveKit Agent       │
│  (Express)  │               │  (Python, remote)    │
└──────┬──────┘               └──────┬──────────────┘
       │                             │  SIP outbound call (Telnyx trunk)
       │                             ▼
       │                        ┌─────────┐
       │                        │ Caller  │
       │                        └─────────┘
       │    STT · LLM · TTS (Soniox + DeepSeek + Cartesia)
       ▼
┌─────────────┐   actions    ┌─────────────┐
│   SQLite    │ ◄───────────► │   Baileys   │  WhatsApp
│ (leads,     │               │ (WhatsApp)  │  mid-call + follow-up
│  callbacks, │               └─────────────┘
│  calls)     │
└─────────────┘
```

**Stack**

| Concern | Tech |
|---|---|
| Telephony / agent | LiveKit Agents + LiveKit SIP (Telnyx trunk) |
| Speech-to-text | Soniox realtime STT (`stt-rt-v5`, auto language ID) |
| Language model | DeepSeek (streaming) |
| Text-to-speech | Cartesia Sonic 3.5 (sub-90ms, multilingual) |
| WhatsApp | Baileys (WhatsApp Business) |
| API + data | Node/Express + SQLite (better-sqlite3) |
| Dashboard | React + HeroUI v3 + Vite + Tailwind v4 |

> Sarvam STT/TTS remain in the codebase as a fallback — set
> `STT_PROVIDER=sarvam` / `TTS_PROVIDER=sarvam` in the agent env to use them.

## Repository layout

```
├── agent/           Python LiveKit agent (STT → LLM → TTS, function tools)
│   ├── agent.py     entrypoint: dial, session, events, follow-up
│   ├── prompts.py   system + follow-up prompts
│   └── tools.py     in-process tools (whatsapp, callback, classify)
├── api/             Node API: calls, leads, callbacks, WhatsApp, scheduler
│   └── src/
├── dashboard/       React dashboard (call activity, leads, callbacks)
├── assets/          architecture image + resume sent in the follow-up
├── Dockerfile       multi-stage build (dashboard + api)
└── TEST_SCENARIOS.md  scripted end-to-end test conversations
```

## Running locally

### 1. API

```bash
cd api
cp ../.env.example ../.env   # fill in keys
npm ci
npm run dev                  # http://localhost:3000
```

### 2. Agent

```bash
cd agent
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# create agent/secrets.env with your LiveKit/Sarvam/DeepSeek keys
lk agent dev .                       # local dev mode, or:
lk agent deploy --secrets-file ./secrets.env .   # deploy to LiveKit Cloud
```

### 3. Dashboard (optional, in dev)

```bash
cd dashboard
npm ci
npm run dev                # proxies /api → localhost:3000
```

### 4. Trigger a call

```bash
curl -X POST http://localhost:3000/api/call/start \
  -H "X-API-Key: <API_SECRET>"
```

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `TARGET_NUMBER` | Number the system dials |
| `WHATSAPP_TO` | Number that receives WhatsApp messages |
| `YOUR_NUMBER` | Your contact number shown in follow-ups |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit Cloud |
| `SIP_OUTBOUND_TRUNK_ID` | Telnyx outbound trunk |
| `SARVAM_API_KEY` | Sarvam STT/TTS (fallback only) |
| `SONIOX_API_KEY` | Soniox realtime STT |
| `CARTESIA_API_KEY` | Cartesia Sonic TTS (per-language native voices) |
| `DEEPSEEK_API_KEY` | LLM |
| `API_SECRET` | Shared key for agent → API calls |

## Deployment

The included `Dockerfile` builds the dashboard and API into one image. On a
VPS with Coolify:

1. Push the repo to GitHub
2. Add a **Public Repository** resource, base directory `/`, build pack
   `Dockerfile`, port `3000`
3. Add the environment variables from `.env.example`
4. Mount two persistent volumes: `/app/api/data` (SQLite) and
   `/app/api/auth_info_baileys` (WhatsApp session)
5. Point the agent's `API_BASE_URL` at the deployed API and redeploy the agent

