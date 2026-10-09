import type { Metadata } from "next";

import { LegalPage } from "@/components/marketing/LegalPage";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = { title: "Acceptable Use Policy", alternates: { canonical: "/acceptable-use" } };

export default function AcceptableUsePage() {
  return (
    <LegalPage
      title="Acceptable Use Policy"
      intro={<p>OpenCMO helps you market your own business with your own content. To keep it safe for everyone, you may not use OpenCMO for the things below. Breaking this policy can lead to removed content or a suspended account.</p>}
      sections={[
        {
          heading: "Content you may not create or publish",
          body: (
            <ul>
              <li>Sexual, explicit or sexually suggestive content of any kind.</li>
              <li>Deepfakes, face swaps, or voices or likenesses of real people used without their consent.</li>
              <li>Content you do not own or have the rights to use, including other people’s videos.</li>
              <li>Hate, harassment, violence, or content that exploits or endangers minors.</li>
              <li>Illegal content, scams, misleading health or financial claims, or “get rich quick” promotions.</li>
            </ul>
          ),
        },
        {
          heading: "Ways you may not use OpenCMO",
          body: (
            <ul>
              <li>Spam, bulk messaging or unsolicited outreach.</li>
              <li>Fake engagement: automated likes, follows, comments or reviews, or running fake accounts.</li>
              <li>Breaking the rules of the platforms you publish to, including posting in communities that forbid self-promotion.</li>
              <li>Collecting or exposing other people’s personal data.</li>
              <li>Trying to bypass limits, access other users’ data or disrupt the service.</li>
            </ul>
          ),
        },
        {
          heading: "Video, image and 3D tools",
          body: (
            <>
              <p>Video tools work only on recordings you own or have permission to use. 3D and animation tools create motion graphics for your videos.</p>
              <p>AI images and video clips are generated only for your own marketing videos. Every request is screened before anything is generated, and every result is screened again before you receive it. Requests and results that break this policy are refused and your credits are returned.</p>
              <p>You may not generate realistic images or video of real, identifiable people, public figures or private individuals, or anything that imitates a brand, logo or product you do not own.</p>
            </>
          ),
        },
        {
          heading: "Reporting",
          body: <p>Report abuse or copyright concerns to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We review reports and remove infringing content.</p>,
        },
      ]}
    />
  );
}
