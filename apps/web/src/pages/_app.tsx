import { type AppType } from "next/app";
import { type Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { trpc } from "@/utils/trpc";
import { PostHogProvider } from "@/components/PostHogProvider";
import "@/styles/globals.css";

const CadenceApp: AppType<{ session: Session | null }> = ({
  Component,
  pageProps: { session, ...pageProps },
}) => {
  return (
    <SessionProvider session={session}>
      <PostHogProvider>
        <Component {...pageProps} />
      </PostHogProvider>
    </SessionProvider>
  );
};

export default trpc.withTRPC(CadenceApp);
