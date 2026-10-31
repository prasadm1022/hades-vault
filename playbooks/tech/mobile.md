# Mobile (Flutter, React Native, iOS, Android)

## Detect
- Flutter: `pubspec.yaml` with `flutter:` SDK dependency, `lib/main.dart`, `android/` + `ios/`.
- React Native: `react-native` in package.json; Expo: `expo` dependency, `app.json`/`app.config.*`, `eas.json`.
- iOS: `*.xcodeproj`, `*.xcworkspace`, `Package.swift`, `Podfile`. Android: `com.android.application`
  plugin in `build.gradle(.kts)`, `AndroidManifest.xml`, `gradle/libs.versions.toml`.

## Commands
| key | Flutter | React Native / Expo | iOS (macOS only) | Android |
|---|---|---|---|---|
| install | `flutter pub get` | see `javascript-typescript.md`; `cd ios && pod install` | `pod install` if Podfile; SwiftPM resolves in build | n/a (Gradle resolves) |
| build | `flutter build apk --debug` (iOS: `flutter build ios --no-codesign`) | `cd android && ./gradlew assembleDebug` | `xcodebuild -scheme <S> -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO -quiet build` | `./gradlew assembleDebug` |
| lint | `flutter analyze` | `npx eslint . --quiet`; `npx expo-doctor` | `swiftlint lint --quiet` | `./gradlew lintDebug` (+ ktlint/detekt if configured) |
| types | (in analyze) | `npx tsc --noEmit` | (compile) | (compile) |
| test | `flutter test` | `npx jest --ci` (preset `jest-expo` or `react-native`) | `xcodebuild test -scheme <S> -destination 'platform=iOS Simulator,name=<device>' -quiet`; SwiftPM `swift test` | `./gradlew testDebugUnitTest` |
| run | `flutter run -d <device>` (background) | `npx expo start` / `npx react-native start` (background) | Xcode/simctl | `./gradlew installDebug` + `adb shell am start` |
| format | `dart format --output=none --set-exit-if-changed .` | `npx prettier --check .` | `swift format lint -r .` if used | ktlint if configured |

Schemes and simulators: `xcodebuild -list`, `xcrun simctl list devices available`. Android devices:
`adb devices`. Flutter codegen: `dart run build_runner build --delete-conflicting-outputs`.

## Layout
Flutter: `lib/{features,core,widgets}`, `test/` (unit + widget), `integration_test/`. RN: `src/` or Expo
Router `app/`; native code only in `android/`/`ios/` (Expo prebuild generates them: do not hand-edit
generated folders in managed projects). iOS: app target + `Tests`/`UITests` targets. Android:
`app/src/main/{java,kotlin,res}`, `app/src/test` (JVM unit), `app/src/androidTest` (device).

## Testing
- Gate: unit/widget tests only (`flutter test`, Jest, `testDebugUnitTest`, XCTest on simulator when on macOS).
- Device/UI tests need a booted emulator or simulator: Flutter `flutter test integration_test -d <id>`,
  Android `./gradlew connectedDebugAndroidTest`, iOS UI tests, RN Detox or Maestro (`maestro test flows/`).
  Run them in QA when a device is available; otherwise record "device tests not run" with the reason.
- Web targets (Flutter web, Expo web) can be checked with Playwright (`../qa-automation.md`).

## Security
- trivy reads `pubspec.lock`, `package-lock.json`/`yarn.lock`, `Podfile.lock`, `Package.resolved`, Gradle lockfiles.
- Review: secrets or API keys in the app bundle (anything shipped to a device is public), cleartext
  traffic (`usesCleartextTraffic`, ATS exceptions), exported Android components, WebView JS bridges,
  tokens in plain storage (use Keychain/Keystore, `flutter_secure_storage`, `expo-secure-store`),
  deep-link handlers trusting parameters, debug flags in release builds. Built APK/IPA review: `../reverse-engineering.md`.

## Pitfalls
- iOS builds and tests need macOS + Xcode: on Windows/Linux report them as n/a, never as passed.
- Signing: debug/unsigned builds only; release keystores and certificates by env-var name; store
  uploads (EAS submit, fastlane deliver, Play Console) are deploy actions, see `../deployment.md`.
- Android Gradle Plugin 8+ needs JDK 17+; `ANDROID_HOME`/`local.properties` `sdk.dir` (never commit it).
- Metro, `flutter run` and emulators never exit: background only, stop afterwards.
- `pod install` can need `pod repo update`; CocoaPods and Ruby versions matter (see `ruby.md`).
- Emulator first boot is slow (minutes): long timeout; prefer one shared emulator per session.

## Small output
`flutter test --reporter=compact`; `xcodebuild -quiet`; Gradle `-q --console=plain`;
`flutter analyze --no-pub 2>&1 | tail -20`.
