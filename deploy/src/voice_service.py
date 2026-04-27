#!/usr/bin/env python3
"""
Voice call service — Telethon + py-tgcalls 2.x
Communicates with Node.js via stdin/stdout JSON messages.
"""

import asyncio
import json
import os
import sys
import traceback
import logging
from pathlib import Path

logging.basicConfig(level=logging.WARNING, stream=sys.stderr,
                    format='%(name)s %(levelname)s %(message)s')

API_ID   = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION_STRING = os.environ.get("TELEGRAM_SESSION_STRING", "")

tl_client = None
calls     = None

# Per-chat state
volume_state: dict = {}   # chat_id -> 0-200 (100 = normal)
repeat_state: dict = {}   # chat_id -> (file_path, remaining)

def send(msg: dict):
    print(json.dumps(msg), flush=True)

def log(msg: str):
    sys.stderr.write("[VS] " + msg + "\n")
    sys.stderr.flush()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_group_call(chat_id: int):
    """Return the active InputGroupCall for chat_id, or None."""
    from telethon.tl import functions
    from telethon.tl.types import InputPeerChannel, InputPeerChat, InputChannel
    try:
        peer = await tl_client.get_input_entity(chat_id)
        if isinstance(peer, InputPeerChannel):
            full = await tl_client(functions.channels.GetFullChannelRequest(
                channel=InputChannel(peer.channel_id, peer.access_hash)
            ))
            return full.full_chat.call
        elif isinstance(peer, InputPeerChat):
            full = await tl_client(functions.messages.GetFullChatRequest(
                chat_id=abs(chat_id)
            ))
            return full.full_chat.call
    except Exception as e:
        log(f"[_get_group_call] {e}")
    return None

# ---------------------------------------------------------------------------
# PyTgCalls init
# ---------------------------------------------------------------------------

async def get_calls():
    global calls, tl_client
    if calls is None:
        if tl_client is None:
            raise RuntimeError("No active user session — use /qr to log in")
        from pytgcalls import PyTgCalls
        calls = PyTgCalls(tl_client)

        # Log available stream/update-related attrs for debugging
        _attrs = [a for a in dir(calls) if any(k in a.lower() for k in ('stream','update','end','event'))]
        log(f"[calls] available attrs: {_attrs}")

        # Register stream-end handler — API differs by py-tgcalls version
        _registered = False

        # Try 1.x / early 2.x style
        if not _registered and hasattr(calls, 'on_stream_end'):
            try:
                @calls.on_stream_end()
                async def _on_stream_end_v1(client, *args):
                    try:
                        update = args[0] if args else None
                        chat_id = getattr(update, 'chat_id', None)
                        if chat_id is None:
                            chat_id = int(update) if update else None
                        if chat_id:
                            await _handle_stream_end(chat_id)
                    except Exception as e:
                        log(f"[stream_end v1] {e}")
                _registered = True
                log("[calls] stream_end handler registered (v1 API)")
            except Exception as e:
                log(f"[calls] on_stream_end v1 failed: {e}")

        # Try 2.x on_update style
        if not _registered and hasattr(calls, 'on_update'):
            try:
                @calls.on_update()
                async def _on_update_v2(client, update):
                    try:
                        cls_name = type(update).__name__
                        if 'StreamEnded' in cls_name or 'stream_end' in cls_name.lower():
                            chat_id = getattr(update, 'chat_id', None)
                            if chat_id:
                                await _handle_stream_end(chat_id)
                    except Exception as e:
                        log(f"[stream_end v2] {e}")
                _registered = True
                log("[calls] stream_end handler registered (v2 on_update API)")
            except Exception as e:
                log(f"[calls] on_update v2 failed: {e}")

        if not _registered:
            log("[calls] WARNING: stream_end handler not registered — repeat/cleanup disabled")

        await calls.start()
        await asyncio.sleep(0.3)
        log("[calls] PyTgCalls started")
    return calls


async def _handle_stream_end(chat_id: int):
    """Handle stream end: repeat if requested, else notify bot."""
    if chat_id in repeat_state:
        file_path, remaining = repeat_state[chat_id]
        if remaining > 0 and Path(file_path).exists():
            repeat_state[chat_id] = (file_path, remaining - 1)
            try:
                from pytgcalls.types import MediaStream, AudioQuality
                tgc = await get_calls()
                stream = MediaStream(
                    file_path,
                    audio_parameters=AudioQuality.HIGH,
                    video_flags=MediaStream.Flags.IGNORE,
                )
                await tgc.play(chat_id, stream)
                send({"ok": True, "event": "repeat_playing",
                      "chat_id": chat_id, "remaining": remaining - 1})
                return
            except Exception as e:
                log(f"[repeat] play error: {e}")
        del repeat_state[chat_id]
    send({"ok": True, "event": "stream_ended", "chat_id": chat_id})

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
        send({"ok": False, "event": "qr_timeout",
              "error": "QR code expired (120s). Use /qr again."})
        try:
            await tl.disconnect()
        except Exception:
            pass
    except Exception as e:
        name = type(e).__name__
        if "SessionPasswordNeeded" in name or "2FA" in str(e):
            send({"ok": False, "event": "qr_error",
                  "error": "الحساب محمي بكلمة مرور (2FA). يرجى تعطيل 2FA مؤقتاً."})
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
# Check participant
# ---------------------------------------------------------------------------

async def cmd_check_participant(chat_id: int, user_id: int):
    """Check if user_id is currently in the voice call of chat_id."""
    try:
        if tl_client is None or not tl_client.is_connected():
            send({"ok": True, "in_call": True, "reason": "no_session"})
            return

        from telethon.tl import functions
        from telethon.tl.types import InputGroupCall

        call_obj = await _get_group_call(chat_id)
        if call_obj is None:
            send({"ok": False, "in_call": False, "reason": "no_active_call"})
            return

        result = await tl_client(functions.phone.GetGroupParticipantsRequest(
            call=InputGroupCall(id=call_obj.id, access_hash=call_obj.access_hash),
            ids=[],
            sources=[],
            offset="",
            limit=500,
        ))

        in_call = any(
            getattr(p.peer, 'user_id', None) == user_id
            for p in result.participants
        )
        send({"ok": True, "in_call": in_call})

    except Exception as e:
        log(f"[check_participant] {e}")
        send({"ok": True, "in_call": True, "reason": "check_error"})

# ---------------------------------------------------------------------------
# Voice call commands
# ---------------------------------------------------------------------------

async def cmd_join_and_play(chat_id: int, audio_file: str):
    try:
        from pytgcalls.types import MediaStream, AudioQuality

        if not Path(audio_file).exists():
            send({"ok": False, "error": f"Audio file not found: {audio_file}",
                  "chat_id": chat_id})
            return

        log(f"[play] chat_id={chat_id} file={audio_file}")

        call_info = await _get_group_call(chat_id)
        if call_info is None:
            send({"ok": False,
                  "error": "لا يوجد مكالمة صوتية نشطة في المجموعة",
                  "chat_id": chat_id})
            return

        tgc = await get_calls()

        stream = MediaStream(
            audio_file,
            audio_parameters=AudioQuality.HIGH,
            video_flags=MediaStream.Flags.IGNORE,
        )
        await tgc.play(chat_id, stream)

        vol = volume_state.get(chat_id, 100)
        try:
            await tgc.change_volume_call(chat_id, vol)
        except Exception:
            pass

        send({"ok": True, "event": "playing", "chat_id": chat_id})
        log(f"[play] started for {chat_id}")

    except Exception as e:
        log(f"[play] error: {traceback.format_exc()}")
        send({"ok": False, "error": repr(e), "chat_id": chat_id})


async def cmd_stop(chat_id: int):
    try:
        tgc = await get_calls()
        await tgc.leave_call(chat_id)
        repeat_state.pop(chat_id, None)
        send({"ok": True, "event": "stopped", "chat_id": chat_id})
    except Exception as e:
        log(f"[stop] error: {e}")
        send({"ok": False, "error": str(e)})


async def cmd_set_volume(chat_id: int, volume: int):
    try:
        volume = max(0, min(200, volume))
        volume_state[chat_id] = volume
        tgc = await get_calls()
        await tgc.change_volume_call(chat_id, volume)
        send({"ok": True, "event": "volume_set", "volume": volume, "chat_id": chat_id})
    except Exception as e:
        log(f"[volume] error: {e}")
        send({"ok": False, "error": str(e), "chat_id": chat_id})


async def cmd_set_repeat(chat_id: int, audio_file: str, count: int):
    try:
        if count > 0:
            repeat_state[chat_id] = (audio_file, count - 1)
        else:
            repeat_state.pop(chat_id, None)
        send({"ok": True, "event": "repeat_set", "count": count, "chat_id": chat_id})
    except Exception as e:
        send({"ok": False, "error": str(e), "chat_id": chat_id})

# ---------------------------------------------------------------------------
# Session background restore
# ---------------------------------------------------------------------------

async def _init_session_bg():
    global tl_client
    if not SESSION_STRING:
        return
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        tl = TelegramClient(
            StringSession(SESSION_STRING), API_ID, API_HASH,
            connection_retries=2, retry_delay=3, timeout=20,
        )
        log("[session] connecting with saved session…")
        await tl.connect()
        me = await tl.get_me()
        if me is None:
            await tl.disconnect()
            log("[session] get_me() returned None — session invalid")
            return
        tl_client = tl
        log(f"[session] restored: {me.first_name}")
        send({"ok": True, "event": "session_activated",
              "name": me.first_name or "",
              "phone": getattr(me, "phone", "") or ""})
    except Exception as e:
        log(f"[session] restore error: {e}")

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def main():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    send({"ok": True, "event": "ready", "session_active": False})
    if SESSION_STRING:
        asyncio.create_task(_init_session_bg())

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
            elif cmd == "check_participant":
                asyncio.create_task(
                    cmd_check_participant(data["chat_id"], data["user_id"])
                )
            elif cmd == "join_and_play":
                asyncio.create_task(
                    cmd_join_and_play(data["chat_id"], data["audio_file"])
                )
            elif cmd == "stop":
                asyncio.create_task(cmd_stop(data["chat_id"]))
            elif cmd == "set_volume":
                asyncio.create_task(
                    cmd_set_volume(data["chat_id"], data["volume"])
                )
            elif cmd == "set_repeat":
                asyncio.create_task(
                    cmd_set_repeat(data["chat_id"], data["audio_file"], data["count"])
                )
            else:
                send({"ok": False, "error": f"Unknown command: {cmd}"})

        except json.JSONDecodeError:
            pass
        except Exception as e:
            log(f"[main loop] {traceback.format_exc()}")
            send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
