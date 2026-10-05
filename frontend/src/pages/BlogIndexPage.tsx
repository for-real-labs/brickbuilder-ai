import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, LayoutDashboard } from "lucide-react";

import { ProfileMenu } from "../components/ProfileMenu";
import { SEO } from "../components/SEO";
import { getBlogPosts } from "../utils/blog-posts";
import { SiteFooter } from "../components/SiteFooter";

const posts = getBlogPosts();

const structuredData = {
  "@context": "https://schema.org",
  "@type": "Blog",
  name: "BrickBuilder AI Blog",
  description:
    "Articles about using AI to design LEGO-compatible brick models, convert images and 3D files into bricks, and build with BrickBuilder AI.",
  url: "https://brickbuilder.ai/blog",
  publisher: {
    "@type": "Organization",
    name: "BrickBuilder AI",
    url: "https://brickbuilder.ai",
  },
};

export default function BlogIndexPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <SEO
        title="BrickBuilder AI Blog | LEGO AI Design"
        description="Learn how AI can help design LEGO-compatible brick models from images, prompts, and 3D files."
        keywords="lego ai blog, ai lego design, ai lego builder, brickbuilder blog, use ai to build legos"
        url="https://brickbuilder.ai/blog"
        structuredData={structuredData}
      />

      <div className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col px-4 pb-10 pt-6 sm:px-6 md:px-8 lg:px-10">
        <header className="flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2">
            <img
              src="/brickbuilder-logo.PNG"
              alt="BrickBuilder"
              className="h-8 w-auto object-contain"
            />
            <span className="hidden text-sm font-semibold text-slate-800 sm:inline">
              BrickBuilder
            </span>
          </Link>

          <nav className="flex items-center gap-2">
            <Link
              to="/dashboard"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              aria-label="Dashboard"
              title="Dashboard"
            >
              <LayoutDashboard className="h-5 w-5" />
            </Link>
            <ProfileMenu />
          </nav>
        </header>

        <main className="flex-1 py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#f44336]">
              Blog
            </p>
            <h1 className="mt-3 text-4xl font-extrabold leading-tight text-slate-950 sm:text-5xl">
              AI LEGO Design Notes
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
              Practical articles about turning images, prompts, and 3D models into
              LEGO-compatible brick builds with AI.
            </p>

            <div className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
              {posts.map((post) => (
                <article key={post.href} className="grid gap-5 py-7 sm:grid-cols-[180px_1fr]">
                  <Link to={post.href} aria-label={post.title}>
                    <img
                      src={post.image}
                      alt={post.imageAlt}
                      className="aspect-[4/3] w-full rounded-lg border border-slate-200 object-cover"
                    />
                  </Link>
                  <div>
                    <p className="text-sm text-slate-500">{post.date}</p>
                    <h2 className="mt-2 text-2xl font-bold text-slate-950">
                      <Link to={post.href} className="transition-colors hover:text-[#f44336]">
                        {post.title}
                      </Link>
                    </h2>
                    <p className="mt-3 text-base leading-7 text-slate-600">
                      {post.description}
                    </p>
                    <Link
                      to={post.href}
                      className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#f44336] transition-colors hover:text-red-700"
                    >
                      Read article
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
