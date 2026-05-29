import { useMemo, useState } from "react";
import { trpc } from "@/utils/trpc";
import { CreditMeter } from "@/components/CreditMeter";

export default function Studio() {
  const [prompt, setPrompt] = useState("lofi hip hop, rainy night, 90bpm");
  const [jobId, setJobId] = useState<string | null>(null);
  // Bumped on every error so the idempotency token is regenerated — the server
  // refunds and locks the failed token, so a retry needs a fresh one.
  const [attempt, setAttempt] = useState(0);

  // Fresh idempotency token per attempt; reused if the same submit is retried
  // (network blip mid-flight) but rotated after a terminal failure.
  const token = useMemo(
    () => (typeof window !== "undefined" ? crypto.randomUUID() : ""),
    [jobId, attempt],
  );

  const utils = trpc.useUtils();
  const generate = trpc.studio.generate.useMutation({
    onSuccess: (job) => {
      setJobId(job.id);
      void utils.credits.getBalance.invalidate();
    },
    onError: () => {
      setAttempt((n) => n + 1);
    },
  });

  const job = trpc.studio.getJob.useQuery(
    { jobId: jobId ?? "" },
    {
      enabled: !!jobId,
      refetchInterval: (data) =>
        data && (data.status === "RUNNING" || data.status === "QUEUED")
          ? 2000
          : false,
    },
  );

  const download = trpc.assets.getDownloadUrl.useQuery(
    { assetId: job.data?.outputAssetId ?? "" },
    { enabled: !!job.data?.outputAssetId },
  );

  const insufficient = generate.error?.message === "INSUFFICIENT_CREDITS";
  const retryRequired = generate.error?.message === "JOB_RETRY_REQUIRED";

  return (
    <main className="container">
      <h1>Studio</h1>
      <CreditMeter />

      <div className="card">
        <textarea
          rows={3}
          style={{ width: "100%" }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            disabled={generate.isLoading}
            onClick={() =>
              generate.mutate({
                kind: "GENERATE_MUSIC",
                params: { prompt },
                idempotencyToken: token,
              })
            }
          >
            {generate.isLoading ? "Submitting…" : "Generate (10 credits)"}
          </button>
        </div>
        {insufficient ? (
          <p className="muted">Out of credits — upgrade to keep generating.</p>
        ) : null}
        {retryRequired ? (
          <p className="muted">
            Previous attempt failed — click Generate to try again.
          </p>
        ) : null}
      </div>

      {jobId ? (
        <div className="card">
          <div>
            Status: <strong>{job.data?.status ?? "…"}</strong>
          </div>
          {job.data?.status === "SUCCEEDED" && download.data ? (
            <a className="btn" href={download.data.url}>
              Download
            </a>
          ) : null}
          {job.data?.status === "FAILED" ? (
            <p className="muted">{job.data.error}</p>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
