import React from 'react';
import posthog from 'posthog-js';

/** Substack owns email collection, validation, and subscription confirmation. */
export function SubstackSubscribe({ placement }: { placement: 'blog_index' | 'article' }) {
  return <section aria-label="Subscribe to AI and LEGO newsletter" className="my-8 rounded-2xl border border-slate-200 bg-white px-3 pt-5 pb-3 text-center sm:px-5">
    <h2 className="text-base font-semibold text-slate-900">Subscribe to AI and LEGO newsletter</h2>
    {/* Substack's compact 150px embed hides the publication logo and title. */}
    <iframe src="https://legoai.substack.com/embed" title="AI and LEGO email subscription"
      width="480" height="150" className="mx-auto block w-full max-w-[480px] border-0 bg-white"
      loading={placement === 'article' ? 'lazy' : 'eager'}
      onFocus={() => posthog.capture('blog_subscribe_form_focused', { placement })} />
    <a href="https://legoai.substack.com/subscribe" target="_blank" rel="noopener noreferrer"
      className="text-xs text-slate-500 underline underline-offset-2 hover:text-[#f44336]"
      onClick={() => posthog.capture('blog_subscribe_link_clicked', { placement })}>Subscribe on Substack</a>
  </section>;
}
