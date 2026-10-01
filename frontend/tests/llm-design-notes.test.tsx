import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LlmDesignNotes } from '../src/components/LlmDesignNotes';
import { summarizeBuildProgress } from '../src/utils/buildProgress';

describe('LlmDesignNotes', () => {
  it('shows a short activity with an icon and shimmer while thinking', () => {
    const markup = renderToStaticMarkup(<LlmDesignNotes notes="" isThinking />);
    expect(markup).toContain('Planning your brick build');
    expect(markup).toContain('build-thinking-shimmer');
    expect(markup).toContain('lucide-blocks');
    expect(markup).toContain('aria-atomic="true"');
  });
  it('renders nothing before work starts and stops shimmering when work stops', () => {
    expect(renderToStaticMarkup(<LlmDesignNotes notes="" />)).toBe('');
    expect(renderToStaticMarkup(<LlmDesignNotes notes="Adding red roof bricks" />)).not.toContain('build-thinking-shimmer');
  });
  it('replaces the previous activity without a scrolling log', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<LlmDesignNotes notes="Checking the brick connections" isThinking />));
      act(() => root.render(<LlmDesignNotes notes={'Checking the brick connections\nAdding the blue windows'} isThinking />));
      expect(container.textContent).toBe('Adding the blue windows');
      expect(container.textContent).not.toContain('Checking');
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(container.querySelector('[class*="overflow-y"]')).toBeNull();
      expect(container.textContent).not.toContain('Brickbuilder AI Output');
    } finally { act(() => root.unmount()); }
  });
  it.each([
    ['Checking segmentation (round 1/3)...', 'Checking segmentation (round 1/3)'],
    ['I am building a robot with a round head and gray arms and legs.', 'Building a robot with a round head and'],
    ['Adding the roof. Checking the brick connections.', 'Checking the brick connections'],
    ['Adding the roof. Ch', 'Adding the roof'],
    ['Preparing the brick design…\n```json\n{"bricks": []}\n```', 'Preparing the brick design'],
    ['', 'Planning your brick build'],
  ])('summarizes current work in one to eight words: %s', (input, expected) => {
    const summary = summarizeBuildProgress(input);
    expect(summary).toBe(expected);
    expect(summary.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(summary.length).toBeGreaterThan(0);
  });
});
