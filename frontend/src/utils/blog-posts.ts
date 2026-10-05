import nativePosts from '../data/blog-posts.json';
import importedPosts from '../data/substack-posts.json';

export interface SubstackPost {
  title: string;
  sourceUrl: string;
  guid: string;
  slug: string;
  content: string;
  description: string;
  author: string;
  publishedAt: string | null;
}

export function getBlogPosts(imported: SubstackPost[] = importedPosts) {
  return [...nativePosts, ...imported.map((post) => ({
    title: post.title,
    href: `/blog/${post.slug}`,
    description: post.description,
    publishedAt: post.publishedAt,
    date: post.publishedAt ? new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(post.publishedAt)) : 'AI and LEGO',
    image: '/assets/blog/ai-and-lego.png',
    imageAlt: 'AI and LEGO',
  }))].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}

export function findSubstackPost(slug: string | undefined, posts: SubstackPost[] = importedPosts) {
  return posts.find((post) => post.slug === slug);
}
