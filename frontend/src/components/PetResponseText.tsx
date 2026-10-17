import React, { Children, cloneElement, isValidElement } from 'react';

const words = (text: string) => text.split(/(\s+)/u);
const isWord = (text: string) => /\S/u.test(text);

function responseParts(children: React.ReactNode): string[] {
  return Children.toArray(children).flatMap(child => {
    if (typeof child === 'string' || typeof child === 'number') return [String(child)];
    return isValidElement<{ children?: React.ReactNode }>(child) ? responseParts(child.props.children) : [];
  });
}

/** Reveal short word bursts while keeping the complete, formatted reply accessible. */
export function PetResponseText({ children }: { children: React.ReactNode }) {
  const parts = responseParts(children);
  const text = parts.join('');
  const wordCount = parts.reduce((count, part) => count + words(part).filter(isWord).length, 0);
  const interval = Math.min(18, 600 / Math.max(1, wordCount - 1));
  let index = 0;
  const reveal = (nodes: React.ReactNode): React.ReactNode => Children.map(nodes, child => {
    if (typeof child === 'string' || typeof child === 'number') return words(String(child)).map((word, part) => isWord(word)
      ? <span key={part} className="pet-response-word" style={{ animationDelay: `${Math.round(index++ * interval)}ms` }}>{word}</span>
      : word);
    if (isValidElement<{ children?: React.ReactNode }>(child) && child.props.children !== undefined) {
      return cloneElement(child, undefined, reveal(child.props.children));
    }
    return child;
  });
  return <span key={text} className="pet-response-text">{reveal(children)}</span>;
}

/** Animate spoken paragraphs without delaying actions, labels, or user messages. */
export function animatePetParagraphs(children: React.ReactNode): React.ReactNode {
  return Children.map(children, child => isValidElement<{ children?: React.ReactNode }>(child) && child.type === 'p'
    ? cloneElement(child, undefined, <PetResponseText>{child.props.children}</PetResponseText>)
    : child);
}
