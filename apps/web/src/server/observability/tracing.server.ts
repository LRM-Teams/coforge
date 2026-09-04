import { SpanStatusCode, context, trace, type Attributes, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

type MessageSendTrace = {
  measure<T>(name: string, operation: (span: Span) => Promise<T>): Promise<T>;
  event(name: string, attributes?: Attributes): void;
};

let initialization: Promise<boolean> | undefined;

async function initializeTracing() {
  initialization ??= (async () => {
    const endpointFile = Bun.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE;
    const endpoint = endpointFile
      ? (await Bun.file(endpointFile).text()).trim()
      : Bun.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (!endpoint) return false;

    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": Bun.env.OTEL_SERVICE_NAME ?? "coforge-web",
        "service.version": Bun.env.OTEL_SERVICE_VERSION ?? "unknown",
        "deployment.environment": Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "unknown",
      }),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }), {
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: 5_000,
        }),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    return true;
  })().catch(() => false);
  return initialization;
}

export async function withMessageSendTrace<T>(
  requestId: string,
  attributes: Attributes,
  operation: (trace: MessageSendTrace) => Promise<T>,
): Promise<T> {
  if (!(await initializeTracing()))
    return operation({
      measure: async (_name, nestedOperation) => {
        const span = trace.getTracer("coforge-web").startSpan("disabled");
        try {
          return await nestedOperation(span);
        } finally {
          span.end();
        }
      },
      event: () => {},
    });

  const tracer = trace.getTracer("coforge-web", "1.0.0");
  const root = tracer.startSpan("message.send", {
    attributes: { ...attributes, "coforge.request_id": requestId },
  });
  const rootContext = trace.setSpan(context.active(), root);
  const handle: MessageSendTrace = {
    async measure(name, nestedOperation) {
      const child = tracer.startSpan(name, undefined, rootContext);
      try {
        return await nestedOperation(child);
      } finally {
        child.end();
      }
    },
    event(name, eventAttributes) {
      root.addEvent(name, eventAttributes);
    },
  };

  try {
    const result = await operation(handle);
    root.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    root.recordException(error instanceof Error ? error : new Error(String(error)));
    root.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    root.end();
  }
}
