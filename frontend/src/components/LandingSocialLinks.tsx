import React from 'react';
import { Github, Instagram, Youtube } from 'lucide-react';
import posthog from 'posthog-js';
import { TikTokIcon } from './TikTokIcon';

const socialLinks = [
  { name: 'GitHub', href: 'https://github.com/for-real-labs/brickbuilder-ai', Icon: Github },
  { name: 'Instagram', href: 'https://www.instagram.com/trybrickbuilder/', Icon: Instagram },
  { name: 'YouTube', href: 'https://www.youtube.com/@trybrickbuilder', Icon: Youtube },
  { name: 'TikTok', href: 'https://www.tiktok.com/@trybrickbuilder/', Icon: TikTokIcon },
];

export function LandingSocialLinks({ visible }: { visible: boolean }) {
  return <nav aria-label="Social links" className="flex items-center justify-center gap-2">
    {socialLinks.map(({ name, href, Icon }) => <a key={name} href={href}
      target="_blank" rel="noopener noreferrer" aria-label={name} tabIndex={visible ? 0 : -1}
      className="flex h-11 w-11 items-center justify-center"
      onClick={() => posthog.capture('landing_social_link_clicked', { platform: name, destination: href })}>
      <Icon aria-hidden="true" className="h-5 w-5" />
    </a>)}
  </nav>;
}
