import { type GetServerSidePropsContext } from "next";
import {
  getServerSession,
  type DefaultSession,
  type NextAuthOptions,
} from "next-auth";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import GoogleProvider from "next-auth/providers/google";
import EmailProvider from "next-auth/providers/email";
import { prisma } from "@cadence/db";
import { env } from "@/env";
import { provisionNewUser } from "@/server/onboarding";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: DefaultSession["user"] & {
      id: string;
      role: string;
    };
  }
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  // Database sessions: we want server-side revocation and a real Session row to
  // join against in tRPC context.
  session: { strategy: "database" },
  providers: [
    GoogleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      // Deliberately false: auto-linking by email would let anyone who knows a
      // user's address and can capture a magic link take over their Google-linked
      // account (and vice-versa). Users who sign in with both methods will need
      // to link accounts explicitly through the account settings page instead.
      allowDangerousEmailAccountLinking: false,
    }),
    EmailProvider({
      server: env.EMAIL_SERVER,
      from: env.EMAIL_FROM,
    }),
  ],
  pages: {
    signIn: "/login",
    verifyRequest: "/login?check-email=1",
  },
  callbacks: {
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // `role` is a column on User; the adapter returns the full row here.
        session.user.role = (user as { role?: string }).role ?? "user";
      }
      return session;
    },
  },
  events: {
    // Fires once, the first time a user record is created. Idempotent by design
    // (provisionNewUser no-ops if a balance already exists).
    async createUser({ user }) {
      await provisionNewUser(user.id);
    },
  },
};

export const getServerAuthSession = (ctx: {
  req: GetServerSidePropsContext["req"];
  res: GetServerSidePropsContext["res"];
}) => getServerSession(ctx.req, ctx.res, authOptions);
