"""
Cadence inference backend (Modal.com).

Exposes a tiny HTTP surface the Next.js app calls from tRPC:
  POST /submit          -> { "call_id": "<id>" }   (non-blocking; spawns GPU fn)
  GET  /status/{call_id} -> { "status": ..., "output": {...} }

The web app never blocks on a cold GPU start: `submit` spawns the function and
returns a Modal call id immediately; the app polls `/status` until terminal and
then records the output asset. The GPU function writes its result straight to
Cloudflare R2 and returns the object key.

Deploy:  modal deploy services/inference/app.py
"""

import os

import modal
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

app = modal.App("cadence-inference")

# GPU image for the actual model work. Pin real model weights / packages here.
gpu_image = modal.Image.debian_slim().pip_install("torch", "soundfile", "boto3")

web_image = modal.Image.debian_slim().pip_install("fastapi[standard]", "boto3")

# Distributed idempotency map: idempotency_key -> call_id. Survives across web
# invocations so the web app's retry-on-timeout can't spawn a duplicate GPU job.
submit_dedupe = modal.Dict.from_name(
    "cadence-inference-submit-dedupe", create_if_missing=True
)

api = FastAPI(title="cadence-inference")


def require_token(authorization: str = Header(default="")) -> None:
    """Bearer check against the token shared with the web app (Modal secret)."""
    expected = os.environ.get("MODAL_API_TOKEN")
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.function(image=gpu_image, gpu="A10G", timeout=900)
def run_inference(kind: str, params: dict, idempotency_key: str) -> dict:
    """
    The heavy GPU job. Loads the right model for `kind`, runs generation/
    separation, uploads the result to R2, and returns the object key + metadata.
    Stubbed here — the contract (return shape) is what the app depends on.
    """
    # ... load model for `kind`, run inference on `params` ...
    # ... upload bytes to R2 via boto3 (S3-compatible) ...
    output_key = f"u/system/{kind}/{idempotency_key}.mp3"
    return {
        "key": output_key,
        "durationMs": 30_000,
        "contentType": "audio/mpeg",
    }


class SubmitBody(BaseModel):
    kind: str
    params: dict = {}
    idempotency_key: str


@api.post("/submit", dependencies=[Depends(require_token)])
def submit(body: SubmitBody) -> dict:
    # Best-effort dedupe so the web client's retry-on-timeout doesn't burn a
    # second GPU hour. Not strictly atomic — two truly concurrent submits with
    # the same key can both spawn before either writes — but in practice the
    # client's retries are sequential with backoff, so the second attempt sees
    # the first write and short-circuits.
    existing = submit_dedupe.get(body.idempotency_key)
    if existing:
        return {"call_id": existing}

    # spawn() returns immediately with a handle; the GPU may still be cold.
    call = run_inference.spawn(body.kind, body.params, body.idempotency_key)
    submit_dedupe[body.idempotency_key] = call.object_id
    return {"call_id": call.object_id}


@api.get("/status/{call_id}", dependencies=[Depends(require_token)])
def status(call_id: str) -> dict:
    fc = modal.functions.FunctionCall.from_id(call_id)
    try:
        # timeout=0 => poll without blocking.
        result = fc.get(timeout=0)
    except TimeoutError:
        return {"status": "running"}
    except modal.exception.OutputExpiredError:
        return {"status": "failed", "error": "result expired"}
    except Exception as exc:  # noqa: BLE001 - surface failure to the poller
        return {"status": "failed", "error": str(exc)}
    return {"status": "succeeded", "output": result}


@app.function(image=web_image, secrets=[modal.Secret.from_name("cadence-inference")])
@modal.asgi_app()
def fastapi_app() -> FastAPI:
    return api
