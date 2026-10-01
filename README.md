# Motion Studio — Android video editor (APK)

A complete, installable **Android video-editing app** built from this repository's
Alight UI dump. The repo shipped the raw UI layer of a video editor (layouts,
drawables, strings, fonts, effect thumbnails) but no runnable app; this work turns
it into a real product you can install on a phone today:

| | |
|---|---|
| **APK** | [`MotionStudio.apk`](MotionStudio.apk) — 3.2 MB, signed, `minSdk 24` (Android 7.0+), `targetSdk 34` |
| **Package** | `com.motionstudio.app` |
| **Permissions** | none — the editor is fully offline, media never leaves the device |
| **Source** | [`android/`](android) — Java host + the editor UI in [`android/app/src/main/assets/www`](android/app/src/main/assets/www) |
| **Build** | `cd android/tools && npm install && npm run build` (no Gradle, no Android SDK needed) |
| **Test** | `cd android/tools && npm test` — 65 headless UI checks |

```bash
# install on a connected phone (USB debugging on)
adb install -r MotionStudio.apk
# or just open MotionStudio.apk on the phone and allow "install unknown apps"
```

---

## What the app does (A → Z)

**Home / workspace**
- Branded home screen with "New project" hero card, recent projects grid, quick-start
  presets (9:16 portrait, 16:9 widescreen), tips card and bottom navigation.
- **Projects** tab: every project on the device with cover art, ratio, duration and
  "last edited" time; sort newest/oldest; long-press or the ⋯ menu to rename,
  duplicate or delete a project.
- **Effects** tab: browser with category filters (All / Color / Blur / Motion),
  effect cards and a detail sheet with preview art and "Use in a project".
- **Studio** tab: profile card, editor settings, local-storage report, about page.

**Editor**
- Canvas preview with checkerboard stage, 16:9 / 9:16 / 1:1 / 4:5 ratios, FIT / FILL /
  SAFE-area canvas modes, and an empty state that invites the first layer.
- Media transport bar: timecode `MM:SS:FF`, play/pause, jump to start/end, timeline zoom.
- **Multi-track timeline** with a ruler, MEDIA / TEXT / AUDIO tracks, waveforms for
  audio, a draggable playhead, tap-to-scrub, and clip blocks you can *drag on the
  timeline* to re-time.
- Layer tools: add **media** (system file picker → IndexedDB, stays on device),
  **audio**, **text**, **shapes** (rectangle / circle / triangle), **solid colours**
  and a generated **sample clip** (canvas + MediaRecorder).
- Clip inspector with *Trim start* / *Duration* sliders for media and *Size* /
  *Start* for text and shapes; drag text directly on the canvas to reposition it.
- Editing actions: **split at playhead**, duplicate/copy, delete, undo & redo
  (40-step history per project), rename project, autosave with a saved indicator.
- **Effects**: apply an effect preset from the browser or the in-editor sheet; the
  layer is badged with the applied effect name.
- **Export**: resolution / frame-rate / duration summary, MP4 · GIF · PNG targets,
  progress dialog, completion card with the file name and a placeholder-media warning.
- Hardware **back button** is wired: it closes a sheet, then the editor, then the app —
  exactly like a native app should behave.
- Keyboard shortcuts when a keyboard is attached: `space` play/pause, `←/→` step frames.

**Under the hood**
- `localStorage` for project documents, **IndexedDB** for media blobs (so a 2 GB video
  is not dumped into JSON), object URLs for preview playback and audio layers that are
  mixed by the clock-driven transport.
- No internet permission at all: no analytics, no ads, no accounts, no network code.

---

## Repository layout

```
MotionStudio.apk                 ← the built, signed app (install this)
android/
  app/src/main/
    AndroidManifest.xml          ← single WebView activity, portrait, offline
    java/com/motionstudio/app/
      MainActivity.java          ← WebView host: file picker, dark chrome, back handling
    res/                         ← launcher icon (adaptive + legacy), theme, strings
    assets/www/                  ← the editor UI (HTML + CSS + JS), ~3 MB with art
      index.html · styles.css · app.js
      assets/features/*.webp     ← the 18 effect thumbnails from this repo
  tools/
    build.mjs                    ← APK build pipeline (aapt2 → javac/ECJ → D8 → zip → sign)
    smoke-test.mjs               ← 60-check jsdom UI test of the real app
    make-icons.sh                ← regenerates the launcher icon set with ImageMagick
    keystore/                    ← self-signed dev signing key (replace for production)
AndroidManifest.xml, res/, assets/, resources.arsc   ← the original UI dump, untouched
```

## Build it yourself

```bash
cd android/tools
npm install          # apk_sign_ts (APK signing) + jsdom (tests)
npm run build        # → android/build/MotionStudio-1.0.apk  (+ copy at repo root)
npm test             # 65 UI checks against the real editor in jsdom
npm run icons        # regenerate mipmap icons (needs ImageMagick)
```

The build needs **no Android SDK and no Gradle**. On first run it downloads a small
pinned toolchain into `~/.cache/android-toolchain` (Temurin JRE 21 + ECJ + D8 +
`android.jar` API 34 + `aapt2` + apksigner) and then runs the same steps Gradle would:
`aapt2 compile/link → compile → D8 → package → zipalign-style alignment → APK
Signature Scheme v2/v3`. See [`android/README.md`](android/README.md) for details,
for the exact tool provenance, and for how to open the project in Android Studio instead.

Every build prints a SHA-256 and verifies itself with Google's own `apksigner`.

## Notes & attribution

- The editor UI in `android/app/src/main/assets/www` was written for this project and
  **reuses art from the UI dump in this repository** (`assets/features/*.webp`) plus the
  screen structure and terminology of the dumped resources (`res/layout/*`,
  `resources.arsc` strings) — see [`docs/UI-MAP.md`](docs/UI-MAP.md) for the mapping.
- That dump is the UI of Alight Motion, © Alight Creative, Inc. This repository is a
  technical/educational reconstruction: the original layouts and binaries are *not*
  redistributed as an app, no Alight Motion code is executed, and the app is not
  affiliated with or endorsed by Alight Creative. Don't ship it to a store.
- The signing key in `android/tools/keystore/` is a self-signed development key
  generated locally (CN=Motion Studio, valid 10 years). Create your own for anything
  public: `keytool -genkeypair -keystore my.p12 -storetype PKCS12 ...`.

<details>
<summary><b>বাংলা সারসংক্ষেপ</b></summary>

এই repo-তে আগে ছিল শুধু একটা ভিডিও এডিটর অ্যাপের **UI ফাইল ডাম্প** (layout, drawable,
strings, ফন্ট, ইফেক্ট থাম্বনেইল) — কোনো চালু অ্যাপ ছিল না। এখন সেটাকে একটা **সম্পূর্ণ
ইনস্টলযোগ্য অ্যান্ড্রয়েড APK** বানানো হয়েছে:

- **`MotionStudio.apk`** (৩.২ মেগাবাইট) — ফোনে কপি করে ইনস্টল করলেই চলবে (Android 7.0+)।
- অ্যাপে আছে: Home / Projects / Effects / Studio স্ক্রিন, সম্পূর্ণ ভিডিও এডিটর —
  ক্যানভাস প্রিভিউ, প্লে/পজ, টাইমকোড, মাল্টি-ট্র্যাক টাইমলাইন, ক্লিপ ড্র্যাগ, স্প্লিট,
  ডুপ্লিকেট, ডিলিট, undo/redo, টেক্সট/শেপ/সলিড কালার লেয়ার, ফোন থেকে ভিডিও/ছবি/অডিও
  যোগ করা, ইফেক্ট ব্রাউজার, এবং এক্সপোর্ট ডায়ালগ।
- সব কিছু **অফলাইনে** চলে — ইন্টারনেট অনুমতি নেই, কোনো ডেটা কোথাও যায় না।
- নিজে বিল্ড করতে: `cd android/tools && npm install && npm run build`
  (Gradle বা Android SDK লাগে না), এবং `npm test` দিয়ে ৬০টা UI টেস্ট চালানো যায়।

⚠️ UI টা Alight Motion অ্যাপের ডাম্প থেকে অনুপ্রাণিত (© Alight Creative, Inc.) —
এটা শেখার/টেকনিক্যাল প্রজেক্ট, Play Store-এ দেওয়ার জন্য নয়।
</details>
