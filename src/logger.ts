import pino from "pino";
import { config } from "./config.js";

/**
 * Structured JSON logging. Cloud Run / Cloud Logging ingests stdout JSON.
 * We redact anything that could carry a token so secrets never hit logs.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.access_token",
      "*.refresh_token",
      "*.client_secret",
      "*.code",
      "*.id_token",
    ],
    censor: "[redacted]",
  },
  formatters: {
    level(label) {
      // Map pino levels to Cloud Logging severity for nicer console rendering.
      return { severity: label.toUpperCase() };
    },
  },
});
