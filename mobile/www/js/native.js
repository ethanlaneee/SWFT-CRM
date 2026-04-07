// ════════════════════════════════════════════════
// SWFT Mobile — Native Plugin Integration
// Handles Capacitor native features when running
// as an actual iOS/Android app
// ════════════════════════════════════════════════

export async function initNativePlugins() {
  // Check if running inside Capacitor
  const isNative = window.Capacitor?.isNativePlatform?.() ?? false;

  if (!isNative) {
    console.log('Running in browser mode — native plugins skipped');
    return;
  }

  console.log('Running as native app — initializing plugins');

  // ── Status Bar ──
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0a0a0a' });
  } catch (e) {
    console.log('StatusBar plugin not available:', e.message);
  }

  // ── Keyboard ──
  try {
    const { Keyboard } = await import('@capacitor/keyboard');
    Keyboard.addListener('keyboardWillShow', (info) => {
      document.body.style.setProperty('--keyboard-h', info.keyboardHeight + 'px');
      document.body.classList.add('keyboard-open');
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.body.style.setProperty('--keyboard-h', '0px');
      document.body.classList.remove('keyboard-open');
    });
  } catch (e) {
    console.log('Keyboard plugin not available:', e.message);
  }

  // ── Push Notifications ──
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const permResult = await PushNotifications.requestPermissions();
    if (permResult.receive === 'granted') {
      await PushNotifications.register();
    }

    PushNotifications.addListener('registration', (token) => {
      console.log('Push registration token:', token.value);
      // TODO: Send token to your server for push notification delivery
      // API.user.update({ pushToken: token.value });
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('Push notification received:', notification);
      if (window.App) {
        App.toast(notification.title || notification.body || 'New notification');
      }
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      console.log('Push notification action:', action);
      // Navigate to relevant page based on notification data
      const data = action.notification.data;
      if (data?.page) {
        window.App?.navigate(data.page, data.params || {});
      }
    });
  } catch (e) {
    console.log('PushNotifications plugin not available:', e.message);
  }

  // ── App (handle back button, app state) ──
  try {
    const { App: CapApp } = await import('@capacitor/app');

    CapApp.addListener('backButton', () => {
      if (window.App?.history?.length > 0) {
        window.App.back();
      } else {
        CapApp.exitApp();
      }
    });

    CapApp.addListener('appStateChange', (state) => {
      if (state.isActive) {
        // App came to foreground — refresh data if needed
        console.log('App resumed');
      }
    });
  } catch (e) {
    console.log('App plugin not available:', e.message);
  }

  // ── Haptics ──
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    // Expose haptic feedback globally for use in button taps
    window.haptic = {
      light: () => Haptics.impact({ style: ImpactStyle.Light }),
      medium: () => Haptics.impact({ style: ImpactStyle.Medium }),
      heavy: () => Haptics.impact({ style: ImpactStyle.Heavy }),
    };
  } catch (e) {
    // Provide no-op fallbacks
    window.haptic = {
      light: () => {},
      medium: () => {},
      heavy: () => {},
    };
  }

  // ── Splash Screen ──
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch (e) {
    console.log('SplashScreen plugin not available:', e.message);
  }
}
