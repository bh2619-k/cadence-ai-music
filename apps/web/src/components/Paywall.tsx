import { useEffect } from "react";
import posthog from "posthog-js";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { trpc } from "@/utils/trpc";

/**
 * In-product paywall. This is the PLG experiment surface: a PostHog feature flag
 * (`paywall-instant-on-exhaustion`) decides whether we fire the upgrade prompt
 * the instant a free user hits zero credits mid-session ("instant") vs. the
 * control. We capture `paywall_shown` / `paywall_cta_clicked` with the variant
 * so conversion lift is measurable per cohort.
 */
export function Paywall({
  trigger,
}: {
  trigger: "credit_exhausted" | "premium_feature";
}) {
  const instant = useFeatureFlagEnabled("paywall-instant-on-exhaustion");
  const variant = instant ? "instant" : "control";

  const checkout = trpc.billing.createCheckout.useMutation({
    onSuccess: ({ url }) => {
      posthog.capture("checkout_redirect", { trigger, variant });
      window.location.href = url;
    },
  });

  useEffect(() => {
    posthog.capture("paywall_shown", { trigger, variant });
  }, [trigger, variant]);

  return (
    <div className="card" role="dialog" aria-label="Upgrade to Pro">
      <h3>You&apos;re out of credits</h3>
      <p className="muted">
        Upgrade to Pro for more daily credits, private generations, stem
        separation, and commercial use.
      </p>
      <button
        className="btn"
        disabled={checkout.isLoading}
        onClick={() => {
          posthog.capture("paywall_cta_clicked", { trigger, variant });
          checkout.mutate({ tier: "PRO" });
        }}
      >
        {checkout.isLoading ? "Redirecting…" : "Upgrade to Pro"}
      </button>
      {checkout.error ? (
        <p className="muted">Something went wrong — please try again.</p>
      ) : null}
    </div>
  );
}
