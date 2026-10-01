# Motion Studio — Android app

The installable Android build of the Motion Studio editor. One activity hosts the
whole editor UI in a WebView; the editor itself is plain HTML/CSS/JS in
`app/src/main/assets/www`, so the app has **no network permission** and every byte of
media stays on the device.

```
app/src/main/
  AndroidManifest.xml      single WebView activity · portrait · minSdk 24 · targetSdk 34
  java/com/motionstudio/app/MainActivity.java
  res/                     adaptive + legacy launcher icon, dark theme, app name
  assets/www/              the editor: index.html · styles.css · app.js · assets/features/*.webp
tools/
  build.mjs                the build pipeline (see below)
  smoke-test.mjs           jsdom UI test suite for the editor
  make-icons.sh            launcher icon generator (ImageMagick)
  keystore/                dev signing key (PEM pair committed, PKCS#12 ignored)
```

## Host app (Java)

`MainActivity` is ~200 lines and does exactly four things:

1. Creates a `WebView` with DOM storage + database + file access enabled, loads
   `file:///android_asset/www/index.html`, and paints the system bars dark.
2. Wires `<input type="file">` to the system picker (`onShowFileChooser` →
   `ACTION_GET_CONTENT` with multi-select), so users can add their own media without
   any storage permission.
3. Routes the hardware back button into the web app first
   (`MS.handleBack()` → close sheet → close editor → back to home → exit).
4. Pauses the WebView and stops preview playback when the app is backgrounded.

No third-party libraries, no Kotlin/AndroidX, nothing to keep in sync — the APK's
`classes.dex` is ~7 KB.

## Editor (assets/www)

| file | what it holds |
|---|---|
| `index.html` | four workspace screens (Home, Projects, Effects, Studio) + the editor (header, canvas, transport, timeline, tool bar) + sheet/toast hosts |
| `styles.css` | the full dark design system: gradients, glass cards, timeline, sheets, icons-free glyph UI, phone/tablet breakpoints, safe-area insets |
| `app.js` | state, persistence, timeline model, playback clock, gestures, sheets, export |

Data model: a project is `{ id, name, ratio, fps, duration, layers[] }`; every layer is
one of `video·image·audio·text·shape` with `{ start, duration, trimIn, effect, … }`.
Projects live in `localStorage`; media blobs live in **IndexedDB** and are streamed back
through object URLs, so nothing is copied into the JSON document. If a device's WebView
denies IndexedDB on `file://`, the editor transparently falls back to a session-only
in-memory store (with a toast) instead of failing. History is a 40-step undo/redo stack
of document snapshots.

Each `<input type="file">` selection is stored as a Blob and rendered by a
real `<video>`/`<audio>`/`<img>` — the transport drives `currentTime` per frame, which is
the closest a WebView can get to a native player without shipping a codec.

## Build pipeline (`node tools/build.mjs`)

The repo intentionally avoids Gradle and a system-wide Android SDK. The script performs
the same steps the Android Gradle Plugin does, with a small pinned toolchain:

| step | tool | provenance |
|---|---|---|
| resources | `aapt2` 2.20 | `aaptjs3` npm package (Linux x64 binary) |
| android.jar | API 34 platform | `Sable/android-platforms` (GitHub blob API) |
| Java | Temurin **JRE 21** | `jdk4py` PyPI wheel (self-contained JRE) |
| compiler | **ECJ 3.45** (`tools.jar` javac as fallback) | `@drxiaozhi/minapk` npm package |
| dexer | **D8 8.2.2** | same package |
| packaging | built-in zip writer | `tools/build.mjs` — writes `resources.arsc`/`classes.dex` uncompressed and 4-byte aligned, like `zipalign` |
| signing | **APK Signature Scheme v2 + v3** | `apk_sign_ts` (pure JS) with a locally generated RSA-2048 key |
| verification | Google `apksigner` + `androguard` | run automatically / with `--verify` |

Everything lands in `~/.cache/android-toolchain` on first run (~150 MB, downloaded once).
Flags:

```bash
node tools/build.mjs                 # build + sign + verify signature
node tools/build.mjs --skip-sign     # unsigned apk, for debugging
node tools/build.mjs --fetch-tools   # only prepare the toolchain
node tools/build.mjs --verify        # additionally parse the APK with androguard
```

Output: `android/build/MotionStudio-1.0.apk`, a copy at the repository root, and a
`.sha256` next to it.

### Signing

`tools/keystore/` holds a self-signed RSA-2048 key (`motion-studio.key.pem`,
`motion-studio.cert.pem`, and a PKCS#12 copy that is git-ignored) so consecutive builds
share one signature and can be installed over each other. This is a **development key** —
generate your own before publishing anything:

```bash
keytool -genkeypair -v -keystore my-release.p12 -storetype PKCS12 \
  -alias mykey -keyalg RSA -keysize 4096 -validity 10000
```

## Tests

```bash
node tools/smoke-test.mjs        # or: npm test
```

Runs the real `app.js` inside jsdom and walks 65 assertions across boot, navigation,
project creation, timeline duplicate/split/delete, undo/redo, playback and scrubbing,
layer sheets (text, shape, media, solid, effects), picking a media file from the device
(the no-IndexedDB fallback path), the export flow, persistence, hardware-back handling
and keyboard shortcuts. It fails on any uncaught page error.

## Opening it in Android Studio instead

The project is a plain Android app; if you prefer Gradle, create a new "Empty Views
Activity" project with `com.motionstudio.app`, copy `AndroidManifest.xml`, `res/` and the
`assets/www` tree, drop `MainActivity.java` in (removing the `findViewById`-less
setup you don't need), set `minSdk 24 / targetSdk 34` and run. The Java source has no
dependency beyond `android.webkit`, so nothing else is required.
