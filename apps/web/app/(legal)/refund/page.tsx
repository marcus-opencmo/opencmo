import type { Metadata } from "next";

import { LegalPage } from "@/components/marketing/LegalPage";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Refund Policy", alternates: { canonical: "/refund" } };

export default function RefundPage() {
  return (
    <LegalPage
      title="Refund Policy"
      intro={<p>We want you to be happy with OpenCMO. If something is wrong, write to us first — most problems can be fixed quickly.</p>}
      sections={[
        {
          heading: "Cancelling",
          body: <p>You can cancel your subscription at any time from the billing page in the app. Your plan stays active until the end of the period you have paid for, and you will not be charged again.</p>,
        },
        {
          heading: "Refunds",
          body: (
            <>
              <p>If you are charged and have not used any credits from that billing period, you can request a full refund within 14 days of the charge. If OpenCMO did not work as described, we will refund the affected credits or the charge.</p>
              <p>Customers in the EU and UK keep their statutory right of withdrawal where it applies.</p>
            </>
          ),
        },
        {
          heading: "How to ask",
          body: <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from your account email with the date of the charge. We reply within 2 business days. Refunds are issued by our payment provider, the merchant of record (currently Polar), to the original payment method.</p>,
        },
      ]}
    />
  );
}
