import pino from "pino";

/**
 * Logger estruturado (JSON) com redaction de credenciais.
 * Em desenvolvimento, LOG_PRETTY=1 pode ser usado com pino-pretty (opcional).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "alcance" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-webhook-key']",
      "req.headers['x-manager-key']",
      "*.senha",
      "*.password",
      "*.cookie",
      "*.token",
      "*.apikey",
    ],
    censor: "[REDACTED]",
  },
});
