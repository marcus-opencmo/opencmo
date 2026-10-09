import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage } from "@/components/marketing/LegalPage";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Terms of Service", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={<p>These terms govern your use of OpenCMO (“OpenCMO”, “we”, “us”), a software product at opencmo.io. By creating an account or using OpenCMO you agree to them. If you use OpenCMO for a company, you accept these terms on its behalf.</p>}
      sections={[
        {
          heading: "1. What OpenCMO is",
          body: (
            <>
              <p>OpenCMO is software. It analyses information you give it (such as your website), prepares a marketing plan, and drafts content: short videos made from recordings you upload, posts, and replies to public conversations. It is not an agency and does not provide human marketing services.</p>
              <p>OpenCMO does not publish anything on its own. Content is published only after you approve it, and only to accounts you have connected yourself. Replies to public conversations are drafted for you to post yourself.</p>
            </>
          ),
        },
        {
          heading: "2. Your account",
          body: <p>You must be at least 18 years old and give accurate information. You are responsible for activity under your account and for keeping the Google account you sign in with secure. Tell us at {SUPPORT_EMAIL} if you believe your account was used without permission. Accounts that never make a purchase are deleted, with all their projects and files, 30 days after sign-up; the app shows the date.</p>,
        },
        {
          heading: "3. Your content and your rights",
          body: (
            <>
              <p>You keep all rights to the content you upload or connect (“Your Content”) and to the output OpenCMO creates from it. You give us a limited licence to process Your Content only to provide the service to you.</p>
              <p>You confirm that you own Your Content or have permission from its owner to edit and republish it. When you import a video by link, OpenCMO asks you to confirm this and records your confirmation. Do not use OpenCMO with content you do not have rights to.</p>
            </>
          ),
        },
        {
          heading: "4. Acceptable use",
          body: <p>You must follow our <Link href="/acceptable-use">Acceptable Use Policy</Link> and the rules of every platform you publish to. We may suspend or remove content or accounts that break it.</p>,
        },
        {
          heading: "5. AI output",
          body: <p>Drafts are generated with AI and can be wrong or incomplete. Review every draft before you approve it; you are responsible for what you publish.</p>,
        },
        {
          heading: "6. Plans, credits and payment",
          body: (
            <>
              <p>Paid plans are monthly subscriptions that include a bundle of credits. Work done by OpenCMO uses credits as shown on our pricing section. Unused credits do not carry over unless the plan says so.</p>
              <p>Payments are processed by our payment provider acting as merchant of record (currently Polar), which also handles sales tax and invoices. You can cancel at any time from your billing page; your plan stays active until the end of the paid period. Refunds follow our <Link href="/refund">Refund Policy</Link>.</p>
            </>
          ),
        },
        {
          heading: "7. Third-party services",
          body: <p>OpenCMO connects to services such as social networks and AI model providers. Your use of those services is governed by their own terms. OpenCMO is independent and not affiliated with TikTok, YouTube, Meta, X or Reddit.</p>,
        },
        {
          heading: "8. Changes and termination",
          body: <p>We may change OpenCMO or these terms; we will tell you about material changes by email or in the app. You may stop using OpenCMO at any time. We may suspend accounts that break these terms or put other users or platforms at risk.</p>,
        },
        {
          heading: "9. Disclaimers and liability",
          body: <p>OpenCMO is provided “as is”. We do not guarantee any particular result, such as reach, followers or sales. To the extent permitted by law, our total liability is limited to the amount you paid us in the 12 months before the claim.</p>,
        },
        {
          heading: "10. Contact",
          body: <p>Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>,
        },
      ]}
    />
  );
}
