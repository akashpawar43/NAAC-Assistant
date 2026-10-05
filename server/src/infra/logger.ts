// The one logger for the whole server (HTTP requests, start-up, scripts), built on pino.
import { createRequire } from "node:module";
import { pino, stdSerializers, type Logger } from "pino";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

export type { Logger };

/** Replaces secret tokens in a URL (query `token=` and `/collect/<token>`) before it is logged. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]+/g, "$1[redacted]").replace(/(\/collect\/)[^/?]+/g, "$1[redacted]");
}

// pino-pretty is a dev dependency; a production install without it falls back to JSON lines.
function canPrettyPrint(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/** `destination` replaces stdout (tests read what would be logged); it implies JSON lines. */
export function createLogger(cfg: Pick<Config, "logLevel" | "logFormat">, destination?: pino.DestinationStream): Logger {
  const pretty = !destination && cfg.logFormat === "pretty" && canPrettyPrint();
  const options: pino.LoggerOptions = {
    level: cfg.logLevel,
    base: { service: "naac-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      // Only what is needed to follow a request; headers (cookies) and bodies are never logged.
      req: (r: FastifyRequest) => ({ method: r.method, url: redactUrl(r.url), remoteAddress: r.ip }),
      res: (r: FastifyReply) => ({ statusCode: r.statusCode }),
      err: stdSerializers.err,
    },
    redact: { paths: ["*.headers.cookie", "*.headers.authorization", "*.headers['set-cookie']"], censor: "[redacted]" },
    ...(pretty && {
      transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,service" } },
    }),
  };
  return destination ? pino(options, destination) : pino(options);
}
