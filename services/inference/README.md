# Cadence inference (Modal.com)

Serverless-GPU backend the web app calls from tRPC. Two endpoints:

- `POST /submit` → spawns the GPU function, returns `{ "call_id": "..." }`
  immediately (no blocking on cold start).
- `GET /status/{call_id}` → `{ status: queued|running|succeeded|failed, output? }`.

The web client lives at
[`apps/web/src/server/inference/modalClient.ts`](../../apps/web/src/server/inference/modalClient.ts)
— it submits, stores the `call_id` on the `GenerationJob`, and polls to a
terminal state (credits are refunded if the backend fails).

## Deploy

```bash
pip install -r requirements.txt
modal secret create cadence-inference MODAL_API_TOKEN=...   # bearer the app sends
modal deploy app.py
```

The deployed ASGI app URL becomes `MODAL_INFERENCE_URL` in the web app's env;
`MODAL_TOKEN` must match the `MODAL_API_TOKEN` secret.
