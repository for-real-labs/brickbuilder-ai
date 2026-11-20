vi.mock('../src/appleSignIn', () => ({ AppleSignIn: class {}, appleSignInDispatch: () => '' }));
vi.mock('../src/applePurchases', () => ({ ApplePurchases: class { dispose() {} }, appleDispatchScript: () => '' }));
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BrickBuilderWebView } from '../src/BrickBuilderWebView';
import type { WebViewProps } from 'react-native-webview';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
const openURL = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react', async () => ({
  ...await vi.importActual('react'),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: () => ({ current: null }),
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock('@react-native-community/netinfo', () => ({ default: { addEventListener: vi.fn() } }));
vi.mock('react-native', () => ({
  Platform: platform, Linking: { openURL },
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
  it('keeps Stripe’s checkout iframe in the iOS WebView without opening Safari', () => {
    platform.OS = 'ios';
    openURL.mockClear();
    const webView = elements(BrickBuilderWebView()).find(element => element.type === 'WebView')!.props as WebViewProps;
    const url = 'https://m.stripe.network/inner.html#url=https%3A%2F%2Fbrickbuilder.ai%2Forder&version=6';
    const request = {
      url, mainDocumentURL: 'https://brickbuilder.ai/order', isTopFrame: false, hasTargetFrame: true,
      navigationType: 'other' as const, lockIdentifier: 1, title: '', loading: false, canGoBack: false, canGoForward: false,
    };

    expect(webView.onShouldStartLoadWithRequest!(request)).toBe(true);
    expect(webView.onShouldStartLoadWithRequest!({ ...request, isTopFrame: true })).toBe(false);
    webView.onOpenWindow!({ nativeEvent: { targetUrl: url } } as Parameters<NonNullable<WebViewProps['onOpenWindow']>>[0]);
    expect(openURL).not.toHaveBeenCalled();

    expect(webView.onShouldStartLoadWithRequest!({ ...request, url: 'https://github.com/for-real-labs', isTopFrame: true })).toBe(false);
    expect(openURL).toHaveBeenCalledOnce();
    expect(openURL).toHaveBeenCalledWith('https://github.com/for-real-labs');
  });

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
