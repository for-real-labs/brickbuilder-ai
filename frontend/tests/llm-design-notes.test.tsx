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
  it('uses the generated summary instead of truncating raw reasoning', () => {
    const markup = renderToStaticMarkup(<LlmDesignNotes
      notes="I need to figure out whether the radius allows the long tail to connect. Preparing the brick design…"
      summary="Shaping the lizard tail" isThinking />);
    expect(markup).toContain('Shaping the lizard tail');
    expect(markup).not.toContain('Preparing');
    expect(markup).not.toContain('radius');
  });
  it('waits for a generated summary without displaying partial reasoning', () => {
    const markup = renderToStaticMarkup(<LlmDesignNotes notes="I should think about" summary="" isThinking />);
    expect(markup).toContain('Waiting for design output');
    expect(markup).not.toContain('I should think');
  });
  it.each([
    ['Painting tortoise shell details', 'paintbrush'],
    ['Verifying the neck-shell connection', 'shield-check'],
    ['Shaping the lizard tail', 'shapes'],
    ['Adjusting the wheel spacing', 'ruler'],
    ['Bridging the snout gap', 'link'],
    ['Reviewing the model from two angles', 'eye'],
    ['Packing the finished model', 'package'],
    ['Saving model files', 'save'],
    ['Adding the tortoise feet', 'blocks'],
  ])('matches the icon to the current activity: %s', (summary, icon) => {
    const markup = renderToStaticMarkup(<LlmDesignNotes notes="" summary={summary} isThinking />);
    expect(markup).toContain(`lucide-${icon}`);
    expect(markup).toContain('aria-hidden="true"');
  });
  it('replaces the icon together with the current summary', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<LlmDesignNotes notes="" summary="Painting the shell" isThinking />));
      expect(container.querySelector('svg')?.classList.contains('lucide-paintbrush')).toBe(true);
      act(() => root.render(<LlmDesignNotes notes="" summary="Checking the connections" isThinking />));
      expect(container.querySelector('svg')?.classList.contains('lucide-shield-check')).toBe(true);
      expect(container.querySelectorAll('svg')).toHaveLength(1);
      expect(container.textContent).toBe('Checking the connections');
    } finally { act(() => root.unmount()); }
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
