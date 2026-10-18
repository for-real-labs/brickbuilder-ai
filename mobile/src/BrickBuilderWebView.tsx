import NetInfo from '@react-native-community/netinfo';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';

import {
  createAnalyticsDispatchScript,
  createNativeBootstrapScript,
  type MobileShellEventName,
} from './analytics';
import { MOBILE_CHANGE_REQUEST, WEB_APP_URL } from './config';
import {
  APP_ROUTES,
  buildAppUrl,
  classifyNavigation,
  getExternalLinkHostname,
} from './navigation';
import {
  OPEN_CHANGE_REQUEST_EVENT,
  parseChangeRequestAccessMessage,
} from './webMessages';

const BRAND_RED = '#f44336';
const WEB_VIEW_SOURCE = { uri: WEB_APP_URL };

type ToolbarButtonProps = {
  label: string;
  symbol: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

function ToolbarButton({
  label,
  symbol,
  active = false,
  disabled = false,
  onPress,
}: ToolbarButtonProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarButton,
        active && styles.toolbarButtonActive,
        disabled && styles.toolbarButtonDisabled,
        pressed && !disabled && styles.toolbarButtonPressed,
      ]}
    >
      <Text style={[styles.toolbarSymbol, active && styles.toolbarTextActive]}>
        {symbol}
      </Text>
      <Text style={[styles.toolbarLabel, active && styles.toolbarTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function BrickBuilderWebView() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(WEB_APP_URL);
  const [isConnected, setIsConnected] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [canRequestChanges, setCanRequestChanges] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsConnected(state.isConnected !== false);
    });
    return unsubscribe;
  }, []);

  const injectAnalytics = useCallback(
    (
      eventName: MobileShellEventName,
      properties: Record<string, string | number | boolean | null> = {},
    ) => {
      webViewRef.current?.injectJavaScript(
        createAnalyticsDispatchScript(eventName, properties),
      );
    },
    [],
  );

  const navigateTo = useCallback(
    (destination: keyof typeof APP_ROUTES) => {
      const destinationUrl = buildAppUrl(WEB_APP_URL, APP_ROUTES[destination]);
      const analytics = createAnalyticsDispatchScript(
        'mobile_shell_navigation_clicked',
        { destination },
      );

      setLoadError(null);
      webViewRef.current?.injectJavaScript(
        `${analytics}\nwindow.location.assign(${JSON.stringify(destinationUrl)}); true;`,
      );
    },
    [],
  );

  const goBack = useCallback(() => {
    if (!canGoBack) return;
    injectAnalytics('mobile_shell_back_clicked');
    webViewRef.current?.goBack();
  }, [canGoBack, injectAnalytics]);

  const reload = useCallback(() => {
    setLoadError(null);
    injectAnalytics('mobile_shell_reload_clicked');
    webViewRef.current?.reload();
  }, [injectAnalytics]);

  const openChangeRequest = useCallback(() => {
    const analytics = createAnalyticsDispatchScript(
      'mobile_shell_change_request_clicked',
    );
    webViewRef.current?.injectJavaScript(
      `${analytics}\nwindow.dispatchEvent(new CustomEvent(${JSON.stringify(
        OPEN_CHANGE_REQUEST_EVENT,
      )})); true;`,
    );
  }, []);

  const retry = useCallback(() => {
    setLoadError(null);
    setLoadProgress(0);
    setWebViewKey((value) => value + 1);
  }, []);

  const openExternalUrl = useCallback(
    (url: string) => {
      injectAnalytics('mobile_shell_external_link_opened', {
        hostname: getExternalLinkHostname(url),
      });
      void Linking.openURL(url).catch(() => {
        setLoadError('BrickBuilder could not open that link.');
      });
    },
    [injectAnalytics],
  );

  const currentPath = (() => {
    try {
      const parsed = new URL(currentUrl);
      return parsed.origin === new URL(WEB_APP_URL).origin ? parsed.pathname : '';
    } catch {
      return '';
    }
  })();

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
      <View style={styles.container}>
        {!isConnected && (
          <View accessibilityRole="alert" style={styles.offlineBanner}>
            <Text style={styles.offlineText}>
              You’re offline. Reconnect to generate or load models.
            </Text>
          </View>
        )}

        <View style={styles.webContainer}>
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={WEB_VIEW_SOURCE}
            style={styles.webView}
            originWhitelist={['*']}
            injectedJavaScriptBeforeContentLoaded={createNativeBootstrapScript(
              Platform.OS === 'android' ? 'android' : 'ios',
              MOBILE_CHANGE_REQUEST,
            )}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            allowsBackForwardNavigationGestures
            allowsInlineMediaPlayback
            allowsFullscreenVideo
            allowsLinkPreview={false}
            applicationNameForUserAgent="BrickBuilderMobile/0.1.0"
            mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
            setSupportMultipleWindows
            onLoadStart={() => {
              setLoadProgress(0.05);
              setLoadError(null);
            }}
            onLoadProgress={({ nativeEvent }) => {
              setLoadProgress(nativeEvent.progress);
            }}
            onLoadEnd={() => {
              setLoadProgress(1);
              injectAnalytics('mobile_shell_loaded', {
                platform: Platform.OS,
              });
            }}
            onNavigationStateChange={(navigationState) => {
              setCanGoBack(navigationState.canGoBack);
              setCurrentUrl(navigationState.url);
            }}
            onMessage={({ nativeEvent }) => {
              const enabled = parseChangeRequestAccessMessage(nativeEvent.data);
              if (enabled !== null) setCanRequestChanges(enabled);
            }}
            onShouldStartLoadWithRequest={(request) => {
              const disposition = classifyNavigation(request.url, WEB_APP_URL);
              if (disposition === 'webview') return true;
              if (disposition === 'external') openExternalUrl(request.url);
              return false;
            }}
            onOpenWindow={({ nativeEvent }) => {
              const disposition = classifyNavigation(
                nativeEvent.targetUrl,
                WEB_APP_URL,
              );
              if (disposition === 'external') {
                openExternalUrl(nativeEvent.targetUrl);
                return;
              }
              if (disposition === 'webview') {
                webViewRef.current?.injectJavaScript(
                  `window.location.assign(${JSON.stringify(nativeEvent.targetUrl)}); true;`,
                );
              }
            }}
            onError={(event) => {
              event.preventDefault();
              setLoadError(
                event.nativeEvent.description || 'BrickBuilder could not be loaded.',
              );
            }}
            onHttpError={({ nativeEvent }) => {
              if (
                nativeEvent.statusCode >= 500 &&
                nativeEvent.url === currentUrl
              ) {
                setLoadError('BrickBuilder is temporarily unavailable.');
              }
            }}
            onContentProcessDidTerminate={reload}
          />

          {loadProgress > 0 && loadProgress < 1 && (
            <View
              accessibilityLabel="Loading BrickBuilder"
              style={[styles.progressBar, { width: `${loadProgress * 100}%` }]}
            />
          )}

          {loadProgress < 0.2 && !loadError && (
            <View pointerEvents="none" style={styles.loadingOverlay}>
              <ActivityIndicator color={BRAND_RED} size="large" />
              <Text style={styles.loadingText}>Loading BrickBuilder…</Text>
            </View>
          )}

          {loadError && (
            <View accessibilityRole="alert" style={styles.errorOverlay}>
              <Text style={styles.errorTitle}>We couldn’t load BrickBuilder</Text>
              <Text style={styles.errorMessage}>{loadError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={retry}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.retryButtonPressed,
                ]}
              >
                <Text style={styles.retryButtonText}>Try again</Text>
              </Pressable>
            </View>
          )}
        </View>

        {Platform.OS !== 'ios' && <View accessibilityRole="toolbar" style={styles.toolbar}>
          <ToolbarButton
            label="Back"
            symbol="‹"
            disabled={!canGoBack}
            onPress={goBack}
          />
          <ToolbarButton
            label="Create"
            symbol="＋"
            active={currentPath === APP_ROUTES.create}
            onPress={() => navigateTo('create')}
          />
          <ToolbarButton
            label="Dashboard"
            symbol="▦"
            active={currentPath === APP_ROUTES.dashboard}
            onPress={() => navigateTo('dashboard')}
          />
          {canRequestChanges && (
            <ToolbarButton
              label="Change"
              symbol="✦"
              onPress={openChangeRequest}
            />
          )}
          <ToolbarButton label="Reload" symbol="↻" onPress={reload} />
        </View>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  offlineBanner: {
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff7ed',
    borderBottomColor: '#fed7aa',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  offlineText: {
    color: '#9a3412',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  webContainer: {
    flex: 1,
    position: 'relative',
  },
  webView: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  progressBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: 3,
    backgroundColor: BRAND_RED,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#ffffff',
  },
  loadingText: {
    color: '#475569',
    fontSize: 15,
    fontWeight: '600',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    paddingHorizontal: 30,
  },
  errorTitle: {
    color: '#0f172a',
    fontSize: 21,
    fontWeight: '800',
    textAlign: 'center',
  },
  errorMessage: {
    maxWidth: 420,
    marginTop: 8,
    color: '#64748b',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: 46,
    minWidth: 132,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
    borderRadius: 23,
    backgroundColor: BRAND_RED,
    paddingHorizontal: 24,
  },
  retryButtonPressed: {
    backgroundColor: '#d9372d',
    transform: [{ scale: 0.98 }],
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  toolbar: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopColor: '#e2e8f0',
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#ffffff',
    paddingHorizontal: 6,
    paddingTop: 5,
  },
  toolbarButton: {
    minHeight: 54,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    borderRadius: 12,
  },
  toolbarButtonActive: {
    backgroundColor: '#fff1f0',
  },
  toolbarButtonDisabled: {
    opacity: 0.32,
  },
  toolbarButtonPressed: {
    backgroundColor: '#f1f5f9',
  },
  toolbarSymbol: {
    color: '#475569',
    fontSize: 23,
    fontWeight: '600',
    lineHeight: 25,
  },
  toolbarLabel: {
    color: '#475569',
    fontSize: 11,
    fontWeight: '700',
  },
  toolbarTextActive: {
    color: BRAND_RED,
  },
});
