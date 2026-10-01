# UI map — from the dumped resources to the running app

The repository originally contained only the *UI layer* of a video editor
(`AndroidManifest.xml`, `res/` with 1 429 files, `assets/`, and a `resources.arsc`
holding ~5 MB of strings) — no code, no Gradle project. This document records how each
part of that interface was turned into the installable Motion Studio app, and what was
intentionally left out.

## Where the design came from

| source in the dump | used for |
|---|---|
| `res/layout/activity_project_list*.xml`, `project_list_*`, `homecard_effect_item.xml`, `listitem_project_list.xml` | Home & Projects screens: project cards, side menu, tabs, "View all", create-project popup |
| `res/layout/create_project_fragment.xml` | New-project sheet (name, ratio, frame rate) |
| `res/layout/activity_edit*.xml` (`actionbar`, `infobar`, `navbar`, `playbar`, `selectbar`) | Editor chrome: header with undo/redo/export, timecode bar, transport, bottom tool bar |
| `res/layout/scene_player_view.xml`, `previewmode_canvas_zoom.xml`, `image_frame.xml` | Canvas preview with checkerboard, fit/fill/safe modes |
| `res/layout/trackheader_*`, `timeline_header.xml`, `timeline_item.xml`, `timeline_grip.xml` | Multi-track timeline: ruler, track headers, clips, playhead |
| `create_project_fragment.xml`, `add_media_visualmedia_item.xml`, `add_media_audio_item.xml`, `add_shape_listentry.xml`, `add_effect_item.xml` | Add-media sheet (video/image/audio), shape picker, solid colour, effects entry |
| `effect_browser_activity.xml`, `effect_cate_item.xml`, `effect_item_ver2.xml`, `effect_detail_frag.xml`, `fragment_effect_settings.xml` | Effects tab: category chips, effect cards, detail sheet, settings sliders |
| `res/layout/export_prepare_dialog.xml`, `export_progress_dialog.xml`, `export_item.xml` | Export sheet: format/resolution summary, progress bar, completion card |
| `res/layout/fragment_blending_opacity.xml`, `fragment_border_and_shadow.xml`, `fragment_speed_keyframe.xml` | Inspector: trim/start/size sliders for the selected layer |
| `res/layout/activity_settings.xml`, `myaccount_license_card.xml`, `activity_about.xml` | Studio tab: profile card, settings list, storage report, about |
| `resources.arsc` strings (`Add Effect`, `Export & Share`, `Project Name`, `Sample Media`, `Fit Composition Area`, `Exporting Video`, `Alight Motion Settings`, …) | Screen titles, buttons, sheet copy and terminology in the app |
| `assets/features/*.webp` (18 files) | Effect browser thumbnails & detail art |
| `res/font/*` (Hind, Roboto, Space Grotesk, serif pro) | Reference for the type scale; the app ships a system-font stack to keep the APK small |
| `res/drawable*/ac_mode_*.webp` (31 files) | The 31 blend modes used by the "Blend Mode" effect entry |

## Screens, feature by feature

| # | Feature in the original UI | In Motion Studio | Notes |
|---|---|---|---|
| 1 | Splash / project list | Home workspace | hero "New project" card, recents, quick-pick ratios, big + in the nav |
| 2 | Project list tabs (Projects / Templates / Samples) | Projects tab | one flat list + sort, plus a copy of every project |
| 3 | Create project (name, ratio, fps) | New-project sheet | 16:9 · 9:16 · 1:1 · 4:5, 24/30/60 fps |
| 4 | Import project / project package (.xml/.alm) | Duplicate + rename in the ⋯ menu | file import is out of scope for a UI clone, see "Left out" |
| 5 | Edit screen: canvas preview | Canvas with fit/fill/safe modes | checked-pattern stage, empty-state call to action |
| 6 | Edit playbar: play, timecode, frame step | Transport bar | `MM:SS:FF` timecode, jump to start/end, timeline zoom |
| 7 | Timeline with element tracks & grips | MEDIA / TEXT / AUDIO tracks | clips drag horizontally to re-time, playhead drags to scrub |
| 8 | Add media (visual + audio browsers) | Add-media sheet + system picker | video/image/audio via `input file`, stored in IndexedDB |
| 9 | Sample Media folder | "Sample clip" quick add | canvas + MediaRecorder generates a 5 s demo clip |
| 10 | Add text element | Text sheet | content, size, colour, start time, drag on canvas |
| 11 | Add shape element | Shape sheet | rectangle / circle / triangle, size, colour |
| 12 | Solid colour / background | Solid colour quick add | gradient-free flat fills, cycle through a palette |
| 13 | Element properties (position, scale, opacity, trim) | Clip inspector | trim start & duration for media, size & start for text/shape |
| 14 | Split, copy, delete, undo/redo | Tool row + header | 40-step undo/redo per project, autosave indicator |
| 15 | Keyframes & animators | — | left out (see below); the timeline model keeps a per-layer property slot for it |
| 16 | Effect browser, categories, favourites, guide | Effects tab | 12 effects with the dump's thumbnails, category chips, detail sheet |
| 17 | Effect settings (sliders, switch, colour, xyz) | Inspector sliders + effect badge | applying an effect names the layer with "✧ effect" |
| 18 | Blend modes (31 modes) | "Blend Mode" effect entry | the 31 mode thumbnails are kept in the dump for a future picker |
| 19 | Export video / GIF / image sequence | Export sheet | format pills, fps/resolution summary, placeholder-media hint |
| 20 | Share project package / QR | — | needs a network + account layer, deliberately absent (app is offline) |
| 21 | Accounts, membership, store, tutorials, ranking | Studio tab + About | replaced by a local profile card and settings; no ads/accounts |
| 22 | Font browser (Latin, Arabic, CJK, imported fonts) | — | out of scope for the timeline clone; text uses the system font stack |
| 23 | Drawing / vector shape editor, camera, live shapes | — | out of scope (see below) |
| 24 | Settings (preview quality, storage, autosave) | Studio tab | toggles that really change behaviour (autosave persists) |
| 25 | Hardware back behaviour | `MS.handleBack()` | sheet → editor → home → exit |

## Left out on purpose

- **Media codecs / real video export.** Decoding and re-encoding MP4 on device needs
  MediaCodec, FFmpeg or a native render graph. The app previews real media through the
  platform's `<video>`/`<audio>` elements and presents the full export flow, UI and
  progress, but it does not mux a new file. This is the one place where a UI clone meets
  its limit — everything else in the editor is functional.
- **Accounts, cloud, store, ads, ranking, creator programme.** The dump contains the
  whole Alight Creative account/paywall surface; none of it belongs in an offline app,
  and the app ships with **zero permissions** instead.
- **Font browser with 100+ bundled fonts.** It would add tens of megabytes; text layers
  already support free colour/size/positioning.
- **Keyframe curves and the drawing/vector editor.** Both are large feature areas of
  their own; the data model (`layer.start`, `layer.duration`, `layer.effect`,
  `layer.x/y/size`) is shaped so they can be added without a rewrite.
