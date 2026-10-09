import type { Metadata } from "next";

import { LegalPage } from "@/components/marketing/LegalPage";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Privacy Policy", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={<p>This policy explains what personal data OpenCMO collects, why, and the choices you have. We collect only what we need to run the product.</p>}
      sections={[
        {
          heading: "What we collect",
          body: (
            <ul>
              <li><strong>Account data</strong>: from your Google sign-in, your email address, name and profile picture; and sign-in records.</li>
              <li><strong>Business information</strong>: the website you enter and the strategy documents OpenCMO creates from it.</li>
              <li><strong>Your content</strong>: videos you upload or import, and the drafts and clips created from them.</li>
              <li><strong>Connected accounts</strong>: access tokens for social accounts you choose to connect, used only to publish what you approve.</li>
              <li><strong>Billing data</strong>: plan and payment status. Card details are handled by our payment provider, not by us.</li>
              <li><strong>Usage data</strong>: basic logs and error reports needed to keep the service working.</li>
            </ul>
          ),
        },
        {
          heading: "How we use it",
          body: <p>To provide OpenCMO, process your content, publish what you approve, bill you, answer support requests and keep the service secure. We do not sell your data and we do not use your content to train AI models.</p>,
        },
        {
          heading: "Service providers",
          body: <p>We use providers to run OpenCMO: hosting and database (Vercel, Supabase), media processing (Modal), AI model providers that process prompts and transcripts to produce drafts, our payment provider acting as merchant of record (currently Polar), and, when you use those features, public social data and publishing integrations. They process data only on our instructions.</p>,
        },
        {
          heading: "Retention",
          body: <p>Processed clips are deleted 7 days after processing finishes. Account data is kept while your account is open. Accounts that never make a purchase are deleted, with all their content, 30 days after sign-up; the app shows the date in advance. When you delete your account, we delete your content and personal data within 30 days, except records we must keep for legal or tax reasons.</p>,
        },
        {
          heading: "Your rights",
          body: <p>You can access, correct, export or delete your data. Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will respond within 30 days. If you are in the EU or UK you may also complain to your local data protection authority.</p>,
        },
        {
          heading: "Contact",
          body: <p><a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>,
        },
      ]}
    />
  );
}
