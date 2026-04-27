#!/usr/bin/env python3
"""
Voice call service using Telethon + py-tgcalls 2.x.
Communicates with Node.js bot via stdin/stdout JSON messages.
"""

import asyncio
import json
import os
import sys
import traceback
import logging
from pathlib import Path

# Enable full debug logging so we can see exactly what pytgcalls/ntgcalls does
logging.basicConfig(level=logging.DEBUG, stream=sys.stderr,
                    format='%(name)s %(levelname)s %(message)s')
# Quiet down noisy loggers we don't care about
for quiet in ('telethon', 'asyncio', 'urllib3', 'httpx'):
    logging.getLogger(quiet).setLevel(logging.WARNING)

API_ID   = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION_STRING = os.environ.get("TELEGRAM_SESSION_STRING", "")

# Debug: log session string status at startup  
import sys as _sys
_sys.stderr.write(f"[VS_STARTUP] SESSION_STRING set: {bool(SESSION_STRING)}, len={len(SESSION_STRING)}\n")
_sys.stderr.flush()

tl_client = None
calls     = None

def send(msg: dict):
    print(json.dumps(msg), flush=True)

def log(msg: str):
    sys.stderr.write("[VS] " + msg + "\n")
    sys.stderr.flush()

# ---------------------------------------------------------------------------
# Patch pytgcalls to log transport params from Telegram
# ---------------------------------------------------------------------------

def patch_pytgcalls_logging():
    """Monkey-patch the connect call to log what Telegram actually returns."""
    try:
        from pytgcalls.mtproto import MtProtoClient

        original_join = MtProtoClient.join_group_call.__wrapped__ if hasattr(
            MtProtoClient.join_group_call, '__wrapped__') else None

        orig_call = MtProtoClient.join_group_call

        async def patched_join(self, chat_id, json_join, invite_hash, video_stopped, join_as):
            result = await orig_call(self, chat_id, json_join, invite_hash, video_stopped, join_as)
            try:
                parsed = json.loads(result)
                transport = parsed.get('transport', {})
                if transport:
                    candidates = transport.get('candidates', [])
                    log(f"[PATCH] Transport from Telegram: "
                        f"ufrag={transport.get('ufrag','?')} "
                        f"candidates={len(candidates)} "
                        f"types={list(set(c.get('type','?') for c in candidates))} "
                        f"protocols={list(set(c.get('protocol','?') for c in candidates))}")
                    for c in candidates[:5]:
                        log(f"  candidate: type={c.get('type')} proto={c.get('protocol')} "
                            f"ip={c.get('ip')} port={c.get('port')}")
                else:
                    log(f"[PATCH] Transport is NULL/empty from Telegram! result={result[:200]}")
            except Exception as pe:
                log(f"[PATCH] Could not parse result: {pe}")
            return result

        MtProtoClient.join_group_call = patched_join
        log("[PATCH] pytgcalls transport logging installed")
    except Exception as e:
        log(f"[PATCH] Could not patch pytgcalls: {e}")

# ---------------------------------------------------------------------------
# PyTgCalls management
# ---------------------------------------------------------------------------

async def get_calls():
    """Return (and lazy-init) the PyTgCalls instance."""
    global calls, tl_client
    if calls is None:
        if tl_client is None:
            raise RuntimeError("No active user session — use /qr to log in")
        patch_pytgcalls_logging()
        from pytgcalls import PyTgCalls
        calls = PyTgCalls(tl_client)
        await calls.start()
        await asyncio.sleep(0.5)
        log("[calls] PyTgCalls started")
    return calls

# ---------------------------------------------------------------------------
# Entity / group-call pre-check
# ---------------------------------------------------------------------------

async def prefetch_group_call(chat_id: int):
    """
    Pre-load the entity and verify the group call is accessible.
    Returns the InputGroupCall or None.
    """
    global tl_client
    try:
        from telethon.tl import functions
        from telethon.tl.types import InputPeerChannel, InputPeerChat

        # Step 1: resolve entity (caches access_hash in Telethon session)
        entity = await tl_client.get_entity(chat_id)
        log(f"[prefetch] entity={entity.__class__.__name__} id={entity.id}")

        # Step 2: get full chat to check for active group call
        peer = await tl_client.get_input_entity(chat_id)
        if isinstance(peer, InputPeerChannel):
            from telethon.tl.types import InputChannel
            full = await tl_client(functions.channels.GetFullChannelRequest(
                channel=InputChannel(peer.channel_id, peer.access_hash)
            ))
            call = full.full_chat.call
        elif isinstance(peer, InputPeerChat):
            full = await tl_client(functions.messages.GetFullChatRequest(chat_id=abs(chat_id)))
            call = full.full_chat.call
        else:
            call = None

        if call is None:
            log(f"[prefetch] No active voice chat in this group!")
            return None
        else:
            log(f"[prefetch] Active group call found: id={call.id} access_hash={call.access_hash}")
            return call
    except Exception as e:
        log(f"[prefetch] Failed: {traceback.format_exc()}")
        return None

# ---------------------------------------------------------------------------
# QR login
# ---------------------------------------------------------------------------

async def cmd_qr_login():
    global tl_client, calls
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession

        if tl_client is not None:
            try:
                await tl_client.disconnect()
            except Exception:
                pass
            tl_client = None
            calls = None

        tl = TelegramClient(StringSession(), API_ID, API_HASH)
        await tl.connect()
        qr = await tl.qr_login()
        send({"ok": True, "event": "qr_ready", "url": qr.url})
        asyncio.create_task(_wait_telethon_qr(tl, qr))

    except Exception as e:
        log(f"[qr] start error: {traceback.format_exc()}")
        send({"ok": False, "error": f"{type(e).__name__}: {e}"})


async def _wait_telethon_qr(tl, qr):
    global tl_client, calls
    try:
        await qr.wait(120)
        me = await tl.get_me()
        from telethon.sessions import StringSession
        session_str = tl.session.save()
        tl_client = tl
        calls = None
        send({
            "ok": True,
            "event": "qr_logged_in",
            "name": me.first_name or "",
            "phone": getattr(me, "phone", "") or "",
            "session_string": session_str,
        })
    except asyncio.TimeoutError:
        send({"ok": False, "event": "qr_timeout", "error": "QR code expired (120s). Use /qr again."})
        try:
            await tl.disconnect()
        except Exception:
            pass
    except Exception as e:
        name = type(e).__name__
        if "SessionPasswordNeeded" in name or "2FA" in str(e):
            send({"ok": False, "event": "qr_error",
                  "error": "الحساب محمي بكلمة مرور (2FA). يرجى تعطيل 2FA مؤقتاً ثم إعادة المحاولة."})
        else:
            log(f"[qr] wait error: {traceback.format_exc()}")
            send({"ok": False, "event": "qr_error", "error": str(e)})
        try:
            await tl.disconnect()
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Session check
# ---------------------------------------------------------------------------

async def cmd_check_session():
    try:
        if tl_client is None or not tl_client.is_connected():
            raise RuntimeError("Not logged in")
        me = await tl_client.get_me()
        send({"ok": True, "event": "session_valid",
              "name": me.first_name or "",
              "phone": getattr(me, "phone", "") or ""})
    except Exception as e:
        send({"ok": False, "event": "session_invalid", "error": str(e)})

# ---------------------------------------------------------------------------
# Voice call commands
# ---------------------------------------------------------------------------

async def cmd_join_and_play(chat_id: int, audio_file: str):
    try:
        from pytgcalls.types import MediaStream, AudioQuality

        if not Path(audio_file).exists():
            send({"ok": False, "error": f"Audio file not found: {audio_file}", "chat_id": chat_id})
            return

        log(f"[play] starting for chat_id={chat_id}, file={audio_file}")

        # Pre-check: ensure entity is cached and group call exists
        call_info = await prefetch_group_call(chat_id)
        if call_info is None:
            send({"ok": False,
                  "error": "لا يوجد مكالمة صوتية نشطة في المجموعة أو تعذّر الوصول إليها",
                  "chat_id": chat_id})
            return

        tgc = await get_calls()

        stream = MediaStream(
            audio_file,
            audio_parameters=AudioQuality.HIGH,
            video_flags=MediaStream.Flags.IGNORE,
        )

        log(f"[play] calling tgc.play({chat_id})")
        await tgc.play(chat_id, stream)
        send({"ok": True, "event": "playing", "chat_id": chat_id})
        log(f"[play] started successfully for {chat_id}")

    except Exception as e:
        tb = traceback.format_exc()
        log(f"[play] error:\n{tb}")
        send({"ok": False, "error": repr(e), "chat_id": chat_id})


async def cmd_stop(chat_id: int):
    try:
        tgc = await get_calls()
        await tgc.leave_call(chat_id)
        send({"ok": True, "event": "stopped", "chat_id": chat_id})
    except Exception as e:
        log(f"[stop] error: {traceback.format_exc()}")
        send({"ok": False, "error": str(e)})


async def cmd_skip(chat_id: int, audio_file: str):
    try:
        from pytgcalls.types import MediaStream, AudioQuality
        tgc = await get_calls()
        stream = MediaStream(
            audio_file,
            audio_parameters=AudioQuality.HIGH,
            video_flags=MediaStream.Flags.IGNORE,
        )
        await tgc.play(chat_id, stream)
        send({"ok": True, "event": "skipped", "chat_id": chat_id})
    except Exception as e:
        log(f"[skip] error: {traceback.format_exc()}")
        send({"ok": False, "error": str(e)})

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def main():
    global tl_client, calls

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    # Always start ready immediately. Session is restored via cmd_restore_session
    # triggered by bot.ts after ready, or user does /qr for fresh login.
    send({"ok": True, "event": "ready", "session_active": False})

    while True:
        try:
            line = await reader.readline()
            if not line:
                break
            data = json.loads(line.decode().strip())
            cmd = data.get("cmd")

            if cmd == "qr_login":
                await cmd_qr_login()
            elif cmd == "check_session":
                await cmd_check_session()
            elif cmd == "join_and_play":
                asyncio.create_task(cmd_join_and_play(data["chat_id"], data["audio_file"]))
            elif cmd == "stop":
                asyncio.create_task(cmd_stop(data["chat_id"]))
            elif cmd == "skip":
                asyncio.create_task(cmd_skip(data["chat_id"], data["audio_file"]))
            else:
                send({"ok": False, "error": f"Unknown command: {cmd}"})
        except json.JSONDecodeError:
            pass
        except Exception as e:
            log(f"[main loop] error: {traceback.format_exc()}")
            send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
