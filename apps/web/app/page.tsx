import type { Metadata } from "next";

import { ControlSection } from "@/components/landing/ControlSection";
import { faqs } from "@/components/landing/data";
import { DemoSection } from "@/components/landing/DemoSection";
import { Departments, Goals } from "@/components/landing/Departments";
import { FaqSection } from "@/components/landing/FaqSection";
import { GalaxyFooter } from "@/components/landing/GalaxyFooter";
import { Hero } from "@/components/landing/Hero";
import { LandingMotion } from "@/components/landing/LandingMotion";
import { LandingNav } from "@/components/landing/LandingNav";
import { PricingSection } from "@/components/landing/PricingSection";
import { JsonLd } from "@/components/seo/JsonLd";
import { PLANS, offerPrices } from "@/lib/pricing";
import { SITE_NAME, SITE_URL, absoluteUrl } from "@/lib/site";
import { createServerClient } from "@/lib/supabase/server";

const DESCRIPTION = "Your AI marketing team: it edits the videos, writes the posts and finds the conversations. Led by an AI CMO. You approve everything.";

export const metadata: Metadata = {
  title: { absolute: "OpenCMO: your AI marketing team for founders" },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
};

// Ai/cái gì/giá bao nhiêu — ba thứ máy trả lời câu hỏi cần để nhắc tới OpenCMO
// đúng. `offers` và FAQ đọc cùng nguồn với trang: giá và câu trả lời không lệch nhau.
function landingLd(faq: { q: string; a: string }[]) {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      logo: absoluteUrl("/icon.svg"),
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_NAME,
      url: SITE_URL,
      description: DESCRIPTION,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      offers: PLANS.filter((plan) => plan.price > 0).map((plan) => ({
        "@type": "Offer",
        name: plan.name,
        price: plan.billedPrice,
        priceCurrency: "USD",
        category: "subscription",
        priceSpecification: { "@type": "UnitPriceSpecification", price: plan.billedPrice, priceCurrency: "USD", unitCode: plan.interval === "year" ? "ANN" : "MON" },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
}

export default async function LandingPage() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  const prices = offerPrices();
  const faq = faqs(prices);
  // Ô WEBSITE (không phải link video): onboarding đọc nó để dựng chiến lược
  // (docs/cmo/san-pham.md §3.1). `site` đi qua đăng nhập tới app.
  const action = user ? "/app" : "/login";

  // Footer nằm NGOÀI <main>: footer trong main không phải landmark contentinfo, nên
  // trình đọc màn hình (và người duyệt Polar dùng nó) không tìm thấy bốn link pháp lý.
  return (
    <div className="landing">
      <LandingMotion />
      <JsonLd data={landingLd(faq)} />
      <LandingNav user={!!user} />
      <main>
        <Hero action={action} fineprint={`$${prices.annual} a month, billed annually · all three departments · cancel anytime`} />
        <Goals />
        <Departments />
        <DemoSection />
        <ControlSection />
        <PricingSection prices={prices} action={action} />
        <FaqSection items={faq} />
      </main>
      <GalaxyFooter action={action} />
    </div>
  );
}
