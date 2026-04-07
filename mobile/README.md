# SWFT Mobile App

Native iOS & Android app for SWFT CRM, built with [Capacitor](https://capacitorjs.com/).

## Prerequisites

- **Node.js** 18+
- **Xcode** 15+ (for iOS builds — Mac only)
- **Android Studio** (for Android builds)
- **Apple Developer Account** ($99/year) for App Store
- **Google Play Developer Account** ($25 one-time) for Play Store

## Quick Start

```bash
# 1. Install dependencies
cd mobile
npm install

# 2. Initialize Capacitor (first time only)
npx cap init swft-mobile com.goswft.app --web-dir www

# 3. Add platforms
npx cap add ios
npx cap add android

# 4. Sync web assets to native projects
npx cap sync

# 5. Open in Xcode (iOS)
npx cap open ios

# 6. Open in Android Studio (Android)
npx cap open android
```

## Development Workflow

After making changes to files in `www/`:

```bash
npx cap sync    # Copy web assets to native projects
npx cap run ios # Build and run on iOS simulator
```

## Architecture

```
mobile/
├── www/                    # Web app (served inside native WebView)
│   ├── index.html          # SPA entry point
│   ├── css/app.css         # Mobile-optimized design system
│   └── js/
│       ├── app.js          # Router & app controller
│       ├── api.js          # API client (connects to goswft.com)
│       ├── auth.js         # Firebase authentication
│       ├── native.js       # Capacitor native plugin integration
│       └── pages/          # Page modules
│           ├── dashboard.js
│           ├── customers.js
│           ├── jobs.js
│           ├── messages.js
│           ├── invoices.js
│           ├── quotes.js
│           ├── schedule.js
│           ├── settings.js
│           ├── more.js
│           └── login.js
├── capacitor.config.ts     # Capacitor configuration
├── package.json            # Dependencies
└── ios/ & android/         # Generated native projects (gitignored)
```

## How Sync Works

The mobile app connects to the **same backend API** (`goswft.com`) and **same Firebase database** as the website. No additional sync logic is needed — everything is shared in real time.

## Building for App Store / Play Store

### iOS (App Store)

1. Open `ios/` in Xcode
2. Set your Team & Bundle ID in Signing & Capabilities
3. Select "Any iOS Device" as build target
4. Product → Archive
5. Distribute via App Store Connect

### Android (Play Store)

1. Open `android/` in Android Studio
2. Build → Generate Signed Bundle / APK
3. Upload to Google Play Console

## Native Features

- **Push Notifications** — New job alerts, message notifications
- **Haptic Feedback** — Tactile response on button taps
- **Status Bar** — Dark theme integration
- **Camera** — Job site photos
- **Deep Links** — Open specific pages from notifications
- **Back Button** — Android hardware back button support
