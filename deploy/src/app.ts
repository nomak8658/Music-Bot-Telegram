import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { writeFileSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";

// Write YouTube cookies file on startup (if env var is set)
export const YT_COOKIES_FILE = "/tmp/yt_cookies.txt";
const ytCookiesEnv = process.env["YOUTUBE_COOKIES"];
if (ytCookiesEnv) {
  try {
    const decoded = Buffer.from(ytCookiesEnv, "base64").toString("utf8");
    writeFileSync(YT_COOKIES_FILE, decoded);
    logger.info("YouTube cookies written from env var");
  } catch (e) {
    logger.error({ e }, "Failed to write YouTube cookies file");
  }
}

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
