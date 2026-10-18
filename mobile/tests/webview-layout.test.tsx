import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BrickBuilderWebView } from '../src/BrickBuilderWebView';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react', async () => ({
  ...await vi.importActual('react'),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: () => ({ current: null }),
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock('@react-native-community/netinfo', () => ({ default: { addEventListener: vi.fn() } }));
vi.mock('react-native', () => ({
  Platform: platform, Linking: { openURL: vi.fn() },
  ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('react-native-webview', () => ({ default: 'WebView' }));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [child, ...elements(child.props.children)];
  });
}

describe('native shell layout', () => {
  it.each(['ios', 'android'])('preserves navigation and safe areas on %s, with no iOS toolbar', os => {
    platform.OS = os;
    const tree = elements(BrickBuilderWebView());
    expect(tree.filter(element => element.props.accessibilityRole === 'toolbar')).toHaveLength(os === 'ios' ? 0 : 1);
    const webView = tree.find(element => element.type === 'WebView');
    expect(webView?.props.allowsBackForwardNavigationGestures).toBe(true);
    expect(webView?.props.onContentProcessDidTerminate).toEqual(expect.any(Function));
    expect(tree[0]?.props.edges).toEqual(['top', 'bottom']);
  });
});
