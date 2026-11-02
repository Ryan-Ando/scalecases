---
name: video-editor
description: Edit ad videos for Scale Cases as reviewable timeline projects (Video Edits tab). Use whenever the user asks to edit, cut, assemble, re-time, caption, add music/VO/disclaimer to, or make a variant of a video, or to act on their video review notes / feedback. Reads the shared editor rules learned from past feedback first.
---

# Video editor (Scale Cases)

Every edit is a **project** in the Shared Drive: `ScaleCases Cloud/Edits/<project>/` with a `timeline.json`
(the edit), draft renders, and the user's review notes. The user reviews drafts in the site's **Video Edits** tab
(scrub, timeline, timestamped notes) and exports the final from there or asks you to. Do not leave WIP videos
anywhere else (no Downloads, no Desktop, no loose files in the library).

## 0. Before every edit: read the rules
Run `ve rules` and follow every rule in it. They are lessons the user approved from earlier reviews and they
override your defaults. If a rule conflicts with the user's current request, the request wins; say so.

`ve` means the helper's Python running `video_edit.py`:
- macOS: `"$HOME/Library/Application Support/ScaleCasesHelper/venv/bin/python" "$HOME/Library/Application Support/ScaleCasesHelper/app/video_edit.py"`
- Windows: `"%LOCALAPPDATA%\ScaleCasesHelper\venv\Scripts\python.exe" "%LOCALAPPDATA%\ScaleCasesHelper\app\video_edit.py"`
- In the scalecases repo you may use `tools/disclaimer-worker/video_edit.py` with the same Python.
If the helper isn't installed, the user runs Mac/Windows setup from the site (Disclaimers tab).

Commands: `ve where` · `ve list` · `ve new <name> --title "..." [--width 1080 --height 1920 --fps 30]` ·
`ve render <name> --note "what changed"` · `ve notes <name> [--all]` · `ve resolve <name> <id> --reply "..."` ·
`ve propose <name> <id> --rule "..."` · `ve export <name> --name 1102-Title-1` · `ve cleanup <name>` · `ve rules`

## 1. Building an edit
1. `ve new <short-name>` (letters, numbers, dashes). Copy or generate sources into `<project>/sources/`
   (clips, VO, music, stills). Library files can be referenced as `{library}/0424/0424-Name.mp4` without copying.
2. Write `timeline.json`. The schema is the docstring at the top of `video_edit.py`; read it. Tracks:
   `video` (sequential clips/stills, in/out/speed/fit/volume), `overlays` (images/clips placed with x/y/w),
   `captions` (text + style; styles `caption`, `disclaimer`, `title`, or your own in `styles`), `audio`
   (VO, music beds with volume and fades). Give every item an `id` and a short `label` (shows in the timeline).
3. `ve render <name> --note "v1: first cut"`. Look at frames yourself before telling the user
   (`ffmpeg -ss <t> -i drafts/vN.mp4 -frames:v 1 /tmp/x.jpg`, then view): captions readable and not over faces,
   disclaimer legible, no black gaps, audio levels sane.
4. Tell the user it's ready in the Video Edits tab with a one-line summary per version. Don't paste file paths
   of drafts as deliverables; the tab is the review place.

## 2. Acting on review notes (the feedback loop)
When the user says they left notes / "check my notes" / at the start of any follow-up on a project:
1. `ve notes <name>` lists open notes with id, version, timestamp and kind.
2. **FIX** notes: change `timeline.json` (or sources) to address each one, render ONE new version covering all
   of them (`--note "v5: moved caption off face at 0:12, music -4 dB after 0:40"`), check the frames at the noted
   times, then `ve resolve <name> <id> --reply "<what you changed, in vN>"` for each.
3. **LESSON** notes: turn the user's words into one general, testable rule that applies to future edits (not
   just this video), e.g. "Captions never sit over a face: check the frame under each caption and move it."
   `ve propose <name> <id> --rule "..."`. The user approves or rejects it in the tab; approved rules are appended
   to `Edits/_editor/RULES.md` automatically. Also apply the lesson to the current video if it's relevant.
4. If a FIX note reveals something the user would clearly want everywhere (they had to say it twice, or it's
   about taste rather than this one shot), ask whether to make it a lesson; don't propose rules unasked.
Never edit `RULES.md` directly except to remove a rule the user tells you to remove.

## 3. Final export
Only when the user approves a version: `ve export <name> --name <mmdd>-<Title>-<n>` (full quality, loudness
normalized, written to `<library>/<mmdd>/`), then `ve cleanup <name>` to delete the drafts (the timeline and
notes stay for variants). Exports land in the ad library, so the Relaunch tab and disclaimer tool pick them up.
Follow the library naming: `0424-Pixar Car PR-2-ai`, no state tag for default versions.

## Standing preferences (from earlier projects; RULES.md adds to these)
- Stills first for generated shots: make a keyframe per shot, let the user pick, then animate from that frame.
  Never spend video-generation credits on an unreviewed composition.
- VO is narration; characters never lip-sync. Full-sentence captions, no word-by-word pop.
- Stock music only (Mixkit / licensed), never AI music. Note licenses.
- Ads need the disclaimer the user specifies, verbatim, usually in the first 5 s (`disclaimer` style).
- Money mentions get real check footage/inserts when the user has provided them.
