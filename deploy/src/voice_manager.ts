import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "./lib/logger";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type VoiceMsg = { ok: boolean; event?: string; error?: string; req_id?: string; [key: string]: unknown };
type Pending = { resolve: (msg: VoiceMsg) => void; timer: ReturnType<typeof setTimeout> };

// Pure push events — never solicited responses
const ASYNC_EVENTS = new Set([
  "ready", "session_activated",
  "stream_ended", "repeat_playing",
  "qr_logged_in", "qr_timeout", "qr_error",
]);

class VoiceManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private reqCount = 0;
  private ready = false;

  start() {
    const venvDir = join(__dirname, "..", ".venv");
    const python = existsSync(join(venvDir, "bin", "python3"))
      ? join(venvDir, "bin", "python3")
      : "python3";

    const scriptPath = join(__dirname, "voice_service.py");
    if (!existsSync(scriptPath)) {
      logger.error("voice_service.py not found");
      return;
    }

    let libPath = "";
    try {
      const p = execFileSync("gcc", ["--print-file-name=libstdc++.so.6"]).toString().trim();
      libPath = p.replace(/\/libstdc\+\+\.so\.6$/, "");
    } catch { /* ignore */ }

    const existing = process.env["LD_LIBRARY_PATH"] ?? "";
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: libPath ? `${libPath}:${existing}` : existing,
    };

    this.proc = spawn(python, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: VoiceMsg = JSON.parse(line);
          logger.debug({ msg }, "VoiceService →");

          // Pure async push events
          if (msg.event === "ready") {
            this.ready = true;
            this.emit("ready");
            continue;
          }
          if (msg.event === "session_activated") {
            this.emit("session_activated", msg);
            continue;
          }
          if (ASYNC_EVENTS.has(msg.event ?? "")) {
            this.emit(msg.event as string, msg);
            continue;
          }

          // Solicited response — match by req_id
          const id = msg.req_id ?? "";
          const entry = id ? this.pending.get(id) : undefined;
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.resolve(msg);
          } else {
            // No matching request — emit as generic message
            logger.warn({ msg }, "VoiceService: unmatched response");
          }
        } catch (e) {
          logger.warn({ line, e }, "VoiceService: JSON parse error");
        }
      }
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString().trim();
      if (txt) logger.warn({ txt }, "VoiceService stderr");
    });

    this.proc.on("exit", (code) => {
      logger.warn({ code }, "VoiceService exited — restarting in 3s");
      this.ready = false;
      this.proc = null;
      // Drain pending with error so callers don't hang
      for (const [id, { resolve, timer }] of this.pending) {
        clearTimeout(timer);
        resolve({ ok: false, error: "VoiceService restarted", req_id: id });
      }
      this.pending.clear();
      setTimeout(() => this.start(), 3000);
    });
  }

  private send(cmd: object) {
    if (!this.proc?.stdin) throw new Error("VoiceService not running");
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private request(cmd: object, timeoutMs = 25000): Promise<VoiceMsg> {
    return new Promise((resolve) => {
      const req_id = `r${++this.reqCount}_${Date.now()}`;
      const timer = setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          logger.warn({ req_id, cmd }, "VoiceService request timed out");
          resolve({ ok: false, error: "Voice service timeout", req_id });
        }
      }, timeoutMs);
      this.pending.set(req_id, { resolve, timer });
      this.send({ ...cmd, req_id });
    });
  }

  isReady() { return this.ready; }

  qrLogin()      { return this.request({ cmd: "qr_login" }, 130_000); }
  checkSession() { return this.request({ cmd: "check_session" }); }

  checkParticipant(chatId: number, userId: number) {
    return this.request({ cmd: "check_participant", chat_id: chatId, user_id: userId }, 12_000);
  }

  joinAndPlay(chatId: number, audioFile: string) {
    return this.request({ cmd: "join_and_play", chat_id: chatId, audio_file: audioFile }, 30_000);
  }

  stop(chatId: number) {
    return this.request({ cmd: "stop", chat_id: chatId }, 12_000);
  }

  setVolume(chatId: number, volume: number) {
    return this.request({ cmd: "set_volume", chat_id: chatId, volume }, 10_000);
  }

  setRepeat(chatId: number, audioFile: string, count: number) {
    return this.request({ cmd: "set_repeat", chat_id: chatId, audio_file: audioFile, count }, 10_000);
  }
}

export const voiceManager = new VoiceManager();
