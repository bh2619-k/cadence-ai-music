import { env } from "@/env";

/**
 * Client for the Modal.com inference backend. Modal endpoints are serverless
 * GPU functions with cold starts, so:
 *  - submit returns immediately with a call id (we don't hold the request open),
 *  - the job is polled to a terminal state from the studio router / client,
 *  - every fetch has an explicit timeout, and submit retries transient 5xx with
 *    backoff so a cold-start blip doesn't drop a paid job.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export type ModalJobKind =
  | "generate_music"
  | "separate_stems"
  | "voice_convert"
  | "music_video";

export type ModalStatus = {
  status: "queued" | "running" | "succeeded" | "failed";
  output?: { key: string; durationMs?: number; contentType?: string };
  error?: string;
};

function baseUrl(): string {
  if (!env.MODAL_INFERENCE_URL) {
    throw new Error("MODAL_INFERENCE_URL is not configured");
  }
  return env.MODAL_INFERENCE_URL.replace(/\/$/, "");
}

async function modalFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    return await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.MODAL_TOKEN ?? ""}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 250ms, 500ms, 1s backoff.
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
  throw lastErr;
}

export async function submitInference(opts: {
  kind: ModalJobKind;
  params: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ callId: string }> {
  return withRetry(async () => {
    const res = await modalFetch("/submit", {
      method: "POST",
      body: JSON.stringify({
        kind: opts.kind,
        params: opts.params,
        idempotency_key: opts.idempotencyKey,
      }),
    });
    if (!res.ok) throw new Error(`Modal submit failed: ${res.status}`);
    const json = (await res.json()) as { call_id: string };
    return { callId: json.call_id };
  });
}

export async function getInferenceStatus(callId: string): Promise<ModalStatus> {
  const res = await modalFetch(`/status/${callId}`, {
    method: "GET",
    timeoutMs: 8_000,
  });
  if (!res.ok) throw new Error(`Modal status failed: ${res.status}`);
  return (await res.json()) as ModalStatus;
}
