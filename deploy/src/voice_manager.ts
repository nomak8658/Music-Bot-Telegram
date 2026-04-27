import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "./lib/logger";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type VoiceMsg = { ok: boolean; event?: string; error?: string; [key: string]: unknown };
type PendingResolve = (msg: VoiceMsg) => void;

// Async/unsolicited events — must not consume a pending resolver
const ASYNC_EVENTS = new Set([
  "ready", "session_activated",
  "stream_ended", "repeat_playing",
  "qr_logged_in", "qr_timeout", "qr_error",
]);

class VoiceManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pendingResolvers: PendingResolve[] = [];
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
          logger.info(`VoiceService msg: ${JSON.stringify(msg)}`);

          if (msg.event === "ready") {
            this.ready = true;
            this.emit("ready");
          } else if (msg.event === "session_activated") {
            logger.info(`VoiceService session activated: ${msg.name || ""}`);
            this.emit("session_activated", msg);
          } else if (ASYNC_EVENTS.has(msg.event ?? "")) {
            // Unsolicited events bypass the resolver queue
            this.emit(msg.event as string, msg);
          } else {
            // Solicited response — give to next pending resolver
            const resolver = this.pendingResolvers.shift();
            if (resolver) resolver(msg);
            else this.emit("message", msg);
          }
        } catch { /* ignore parse errors */ }
      }
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString().trim();
      if (txt) logger.warn({ txt }, "VoiceService stderr");
    });

    this.proc.on("exit", (code) => {
      logger.warn({ code }, "VoiceService exited");
      this.ready = false;
      this.proc = null;
    });
  }

  private send(cmd: object) {
    if (!this.proc?.stdin) throw new Error("VoiceService not running");
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private request(cmd: object): Promise<VoiceMsg> {
    return new Promise((resolve) => {
      this.pendingResolvers.push(resolve);
      this.send(cmd);
    });
  }

  isReady() { return this.ready; }

  qrLogin()          { return this.request({ cmd: "qr_login" }); }
  checkSession()     { return this.request({ cmd: "check_session" }); }

  checkParticipant(chatId: number, userId: number) {
    return this.request({ cmd: "check_participant", chat_id: chatId, user_id: userId });
  }

  joinAndPlay(chatId: number, audioFile: string) {
    return this.request({ cmd: "join_and_play", chat_id: chatId, audio_file: audioFile });
  }

  stop(chatId: number) {
    return this.request({ cmd: "stop", chat_id: chatId });
  }

  setVolume(chatId: number, volume: number) {
    return this.request({ cmd: "set_volume", chat_id: chatId, volume });
  }

  setRepeat(chatId: number, audioFile: string, count: number) {
    return this.request({ cmd: "set_repeat", chat_id: chatId, audio_file: audioFile, count });
  }
}

export const voiceManager = new VoiceManager();
