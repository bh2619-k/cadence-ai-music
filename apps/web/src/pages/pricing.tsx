import { useSession, signIn } from "next-auth/react";
import { trpc } from "@/utils/trpc";

const PLANS = [
  {
    tier: "FREE",
    name: "Free",
    price: "$0",
    blurb: "10 credits/day · watermarked · public library.",
  },
  {
    tier: "PRO",
    name: "Pro",
    price: "$12/mo",
    blurb:
      "100 credits/day · private generations · stem splitter · commercial license.",
  },
  {
    tier: "STUDIO",
    name: "Studio",
    price: "$39/mo",
    blurb: "500 credits/day · music video · priority GPU.",
  },
] as const;

export default function Pricing() {
  const { data: session } = useSession();
  const checkout = trpc.billing.createCheckout.useMutation({
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
  });

  return (
    <main className="container">
      <h1>Pricing</h1>
      <div className="grid">
        {PLANS.map((plan) => (
          <div key={plan.tier} className="card">
            <h3>{plan.name}</h3>
            <div>
              <strong>{plan.price}</strong>
            </div>
            <p className="muted">{plan.blurb}</p>
            {plan.tier === "FREE" ? (
              <span className="muted">Included on signup</span>
            ) : session ? (
              <button
                className="btn"
                disabled={checkout.isLoading}
                onClick={() =>
                  checkout.mutate({ tier: plan.tier as "PRO" | "STUDIO" })
                }
              >
                {checkout.isLoading ? "Redirecting…" : `Upgrade to ${plan.name}`}
              </button>
            ) : (
              <button className="btn" onClick={() => signIn()}>
                Sign in to upgrade
              </button>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
