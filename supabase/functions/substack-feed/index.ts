import { handleSubstackFeedRequest } from '../_shared/substack-feed.js';

Deno.serve((request) => handleSubstackFeedRequest(request, {
  secret: Deno.env.get('SUBSTACK_FEED_PROXY_SECRET'),
  feedUrl: Deno.env.get('SUBSTACK_FEED_URL'),
}));
