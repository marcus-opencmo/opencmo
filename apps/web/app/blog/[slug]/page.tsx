import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BlogCta } from "@/components/blog/BlogCta";
import { Breadcrumbs } from "@/components/blog/BlogChrome";
import { PostCard } from "@/components/blog/PostCard";
import { ReadingProgress, Toc } from "@/components/blog/ReadingAids";
import { JsonLd } from "@/components/seo/JsonLd";
import { AUTHORS } from "@/content/blog/authors";
import { findCategory } from "@/content/blog/categories";
import { formatDate, getAllPosts, getPost, getRelatedPosts } from "@/lib/blog";
import { OG_DEFAULTS, SITE_NAME, SITE_URL, absoluteUrl } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return {};
  const author = AUTHORS[post.author];
  return {
    title: post.title,
    description: post.description,
    keywords: post.keywords,
    authors: [{ name: author.name, url: author.url }],
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      ...OG_DEFAULTS,
      type: "article",
      title: post.title,
      description: post.description,
      url: `/blog/${post.slug}`,
      publishedTime: post.date,
      modifiedTime: post.updated,
      authors: [author.name],
      section: findCategory(post.category)?.name,
      tags: post.keywords,
    },
    twitter: { card: "summary_large_image", title: post.title, description: post.description },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug);
  if (!post) notFound();
  const category = findCategory(post.category)!;
  const author = AUTHORS[post.author];
  const url = absoluteUrl(`/blog/${post.slug}`);
  const related = getRelatedPosts(post);
  const toc = post.toc.filter((item) => item.level === 2);

  const ld: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "@id": `${url}#article`,
      headline: post.title,
      description: post.description,
      abstract: post.answer,
      url,
      mainEntityOfPage: url,
      image: absoluteUrl(`/blog/${post.slug}/opengraph-image`),
      datePublished: post.date,
      dateModified: post.updated,
      author: { "@type": "Person", name: author.name, jobTitle: author.role, url: author.url },
      publisher: { "@type": "Organization", "@id": `${SITE_URL}/#organization`, name: SITE_NAME, logo: absoluteUrl("/icon.svg") },
      articleSection: category.name,
      keywords: post.keywords.join(", "),
      wordCount: post.words,
      inLanguage: "en",
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Blog", item: absoluteUrl("/blog") },
        { "@type": "ListItem", position: 2, name: category.name, item: absoluteUrl(`/blog/category/${category.slug}`) },
        { "@type": "ListItem", position: 3, name: post.title, item: url },
      ],
    },
  ];
  if (post.faq.length > 0) {
    ld.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: post.faq.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    });
  }

  return (
    <main className="blog-main">
      <ReadingProgress />
      <JsonLd data={ld} />
      <article className="blog-article">
        <header className="blog-article-header">
          <Breadcrumbs items={[{ name: "Blog", href: "/blog" }, { name: category.name, href: `/blog/category/${category.slug}` }, { name: post.title }]} />
          <Link href={`/blog/category/${category.slug}`} className="blog-article-category">{category.name}</Link>
          <h1>{post.title}</h1>
          <p className="blog-article-dek">{post.description}</p>
          <div className="blog-byline">
            <span className="blog-byline-avatar" aria-hidden="true">{author.name.charAt(0)}</span>
            <span>
              <strong>{author.name}</strong>
              <span>{author.role}</span>
            </span>
            <span className="blog-byline-meta">
              <time dateTime={post.date}>{formatDate(post.date)}</time>
              {post.updated !== post.date && (
                <> · Updated <time dateTime={post.updated}>{formatDate(post.updated)}</time></>
              )}
              {" · "}{post.readingMinutes} min read
            </span>
          </div>
        </header>

        <div className="blog-article-layout">
          <div className="blog-article-main">
            {/* Màn hẹp: mục lục gập trên đầu bài. Màn rộng: rail dính bên phải. */}
            {toc.length > 1 && (
              <details className="blog-toc-mobile">
                <summary>On this page</summary>
                <Toc items={toc} />
              </details>
            )}

            <section className="blog-answer" aria-label="Short answer">
              <p className="blog-answer-label">Short answer</p>
              <p>{post.answer}</p>
            </section>

            <div className="blog-prose blog-article-body" dangerouslySetInnerHTML={{ __html: post.html }} />

            {post.faq.length > 0 && (
              <section className="blog-faq" aria-labelledby="faq">
                <h2 id="faq">Frequently asked questions</h2>
                {post.faq.map((item) => (
                  <details key={item.q}>
                    <summary>{item.q}</summary>
                    <p>{item.a}</p>
                  </details>
                ))}
              </section>
            )}

            <BlogCta />
          </div>

          {toc.length > 1 && (
            <aside className="blog-toc" aria-label="On this page">
              <p className="blog-toc-title">On this page</p>
              <Toc items={toc} />
            </aside>
          )}
        </div>
      </article>

      {related.length > 0 && (
        <section className="blog-related" aria-labelledby="related-title">
          <h2 id="related-title">Keep reading</h2>
          <div className="post-grid">
            {related.map((p) => <PostCard key={p.slug} post={p} />)}
          </div>
        </section>
      )}
    </main>
  );
}
