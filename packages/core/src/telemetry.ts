import { Config, Effect, Layer, Option } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Otlp from "effect/observability/Otlp";

/**
 * Parse the standard `OTEL_EXPORTER_OTLP_HEADERS` shape (`k1=v1,k2=v2`) into a
 * header record. Splits on the FIRST `=` per entry so a header value may itself
 * contain `=` (e.g. base64 / `Bearer` tokens). Blank entries are skipped.
 */
export const parseOtlpHeaders = (raw: string) => {
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    headers[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return headers;
};

/**
 * Optional OTLP forwarder — config-gated, OFF by default.
 *
 * Local `.data/events.jsonl` (Observability.recordRun) stays the load-bearing
 * ledger. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, this ALSO sends to a cloud
 * OTel backend (Axiom, Grafana/Tempo, Honeycomb, an OTel Collector, …): every
 * log line as an OTLP log record — each `RunEvent` included, so the two sinks
 * carry the same annotated record — and every span (`Effect.fn`,
 * `Effect.withSpan`) as an OTLP trace. `Otlp.layerJson` installs the logger,
 * the tracer and the metrics exporter together. When the endpoint is unset the
 * layer is `Layer.empty`: no network, no HttpClient built, zero overhead, and
 * spans stay in memory only. Additive only (never replaces the JSONL append);
 * `OtlpLogger` merges with the existing console logger by default.
 *
 * Auth rides `OTEL_EXPORTER_OTLP_HEADERS` (e.g. Axiom's `Authorization` +
 * `X-Axiom-Dataset`) so credentials stay env-only, never in code.
 */
export const telemetryLayer = Layer.unwrap(
  Effect.gen(function* telemetryLayer() {
    const endpoint = yield* Config.option(
      Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")
    );
    const headers = yield* Config.option(
      Config.String("OTEL_EXPORTER_OTLP_HEADERS")
    );
    return Option.match(endpoint, {
      onNone: () => Layer.empty,
      onSome: (baseUrl) =>
        Otlp.layerJson({
          baseUrl,
          headers: Option.getOrUndefined(Option.map(headers, parseOtlpHeaders)),
          resource: { serviceName: "owner-telegram-bot" },
        }).pipe(Layer.provide(FetchHttpClient.layer)),
    });
  })
);
