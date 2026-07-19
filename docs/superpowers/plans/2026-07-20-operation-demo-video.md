# Operation Demo Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a verified, approximately three-minute 1920×1080 MP4 showing the real standard-spinner workflow and the real Knight Fortress diagnostic workflow with burned-in Traditional Chinese captions and background music.

**Architecture:** A Playwright capture script will run the local Vite application in a clean browser context, perform only real UI interactions, and inject a separate fixed caption/title overlay without changing application behavior. A deterministic render script will use a pinned local `ffmpeg-static` binary to combine the captured WebM with a generated low-volume ambient audio bed and export MP4; a verifier will inspect duration, dimensions, codecs, privacy text, and required scene markers.

**Tech Stack:** TypeScript, Playwright Chromium, Vite preview server, Node.js, `ffmpeg-static`, HTML/CSS caption overlays, MP4/H.264/AAC.

## Global Constraints

- Output is 1920×1080 MP4 with a target duration of 2:40–3:20.
- Use burned-in Traditional Chinese subtitles and light background music; do not add narration.
- Show the complete standard spinner path before the Knight Fortress diagnosis and safety block.
- Do not claim that an unresolved model is production-ready.
- Do not reveal local paths, email addresses, account data, or other personal information.
- Keep `Copy of Beyblade X Knight Fortress.stl` local and untracked; never stage or commit it.
- Preserve a silent video variant as a fallback.

---

## File Map

- Create `scripts/video/demo-timeline.ts`: caption copy, scene identifiers, display durations, and privacy-safe visible filenames.
- Create `scripts/video/capture-demo.ts`: real browser interactions, title/caption overlays, viewport capture, and raw WebM output.
- Create `scripts/video/render-demo.mjs`: deterministic music generation and WebM-to-MP4 rendering through `ffmpeg-static`.
- Create `scripts/video/verify-demo.mjs`: machine verification of container metadata, duration, dimensions, audio/video streams, and capture manifest.
- Create `scripts/video/demo-timeline.test.ts`: checks timeline ordering, duration bounds, required safety wording, and privacy exclusions.
- Create `scripts/video/README.md`: exact reproducible commands and output locations.
- Modify `package.json`: add video scripts and the pinned renderer dependency.
- Modify `.gitignore`: ignore generated video artifacts while retaining scripts and manifests intended for source control.
- Generate but do not commit `artifacts/video/spinner-laser-kit-demo-silent.webm` and `artifacts/video/spinner-laser-kit-demo-zh-hant.mp4`.

### Task 1: Define and validate the demonstration timeline

**Files:**
- Create: `scripts/video/demo-timeline.ts`
- Create: `scripts/video/demo-timeline.test.ts`

**Interfaces:**
- Produces: `DemoScene { id: string; caption: string; holdMs: number }` and `DEMO_SCENES: readonly DemoScene[]` for the capture script.
- Produces: `assertSafeCaptionText(text: string): void`, which rejects `/Users/`, email-address patterns, and claims that Knight Fortress is ready for production.

- [ ] **Step 1: Write the failing timeline tests**

Test that scene IDs occur in this order: `title`, `privacy`, `import`, `inspection`, `axis`, `material`, `decomposition`, `engraving`, `export`, `knight-import`, `knight-repair`, `knight-block`, `closing`. Assert summed `holdMs` is between 160000 and 200000, captions contain `本機瀏覽器`, `材料測試片`, and `未通過安全檢查`, and no caption matches `/Users/` or an email pattern.

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npx vitest run scripts/video/demo-timeline.test.ts`

Expected: FAIL because `./demo-timeline` cannot be resolved.

- [ ] **Step 3: Implement the typed timeline**

Create thirteen immutable scenes with concrete Traditional Chinese captions matching the approved storyboard. Allocate 10–18 seconds to each normal scene and 18–24 seconds to each Knight Fortress scene so the total is 160–200 seconds. Implement `assertSafeCaptionText` and validate all captions when the module loads.

- [ ] **Step 4: Run the focused test**

Run: `npx vitest run scripts/video/demo-timeline.test.ts`

Expected: one test file passes with no privacy or duration failures.

- [ ] **Step 5: Commit the timeline**

```bash
git add scripts/video/demo-timeline.ts scripts/video/demo-timeline.test.ts
git commit -m "test: define demo video timeline"
```

### Task 2: Capture the real browser workflow

**Files:**
- Create: `scripts/video/capture-demo.ts`
- Create: `scripts/video/README.md`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `DEMO_SCENES` and `assertSafeCaptionText` from `demo-timeline.ts`.
- Produces: `artifacts/video/spinner-laser-kit-demo-silent.webm` and `artifacts/video/capture-manifest.json`.
- Command: `KNIGHT_FORTRESS_STL="<absolute local path>" npm run video:capture`.

- [ ] **Step 1: Add a dry-run capture assertion**

Add `--dry-run` handling that validates the standard fixture `fixtures/acceptance/symmetric-textured.stl`, requires `KNIGHT_FORTRESS_STL` to resolve to an existing `.stl` file, checks the output directory is ignored by Git, and prints all thirteen scene IDs without launching Chromium.

- [ ] **Step 2: Run the dry-run before implementation**

Run: `KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" npx tsx scripts/video/capture-demo.ts --dry-run`

Expected: FAIL because the capture script and `tsx` command do not yet exist.

- [ ] **Step 3: Implement capture with actual UI selectors**

Start `npm run dev -- --host 127.0.0.1` as a child process and wait for its printed URL. Launch Chromium with `recordVideo: { dir: 'artifacts/video/raw', size: { width: 1920, height: 1080 } }`, create a 1920×1080 page, and inject a fixed title/caption overlay as a sibling of the React root. Use the same accessible selectors already proven in `e2e/helpers.ts`, `e2e/happy-path.spec.ts`, and `e2e/mesh-repair.spec.ts`.

For the standard model, set `fixtures/acceptance/symmetric-textured.stl`, click `分析模型`, wait for `軸心`, confirm the automatic axis, click `下一步`, accept `接受拆件建議`, select `plywood-3`, generate `產生雕刻與材料設定`, and show the blocked export preflight. Scroll or frame the 3D viewport and each relevant panel before holding each caption.

Start a new project page for Knight Fortress, set the file from `KNIGHT_FORTRESS_STL`, click `分析模型`, show `非流形邊：105` and `退化三角形：63`, grant the explicit advanced-repair consent, run `進階修復`, and show `修復結果未通過安全檢查`, `開放邊界：41 → 41`, and `非流形邊：49 → 49`. Do not click a disabled production action.

Close the context to flush video, rename the recorded file to `spinner-laser-kit-demo-silent.webm`, and write a manifest containing only scene IDs, relative fixture labels, timestamps, viewport, and browser version. Always terminate the Vite child process in `finally`.

- [ ] **Step 4: Add reproducible scripts and ignore rules**

Add `"video:capture": "tsx scripts/video/capture-demo.ts"` to `package.json`; use the existing transitive `tsx` binary only if `npm exec tsx -- --version` succeeds, otherwise add `tsx` as a pinned dev dependency. Add `/artifacts/video/` to `.gitignore`. Document the command, local-only Knight path, and output files in `scripts/video/README.md`.

- [ ] **Step 5: Run the dry-run and capture**

Run:

```bash
KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" npm run video:capture -- --dry-run
KNIGHT_FORTRESS_STL="$PWD/Copy of Beyblade X Knight Fortress.stl" npm run video:capture
```

Expected: the dry-run lists thirteen scenes; capture exits zero and creates a non-empty silent WebM plus JSON manifest without recording the absolute STL path.

- [ ] **Step 6: Commit capture tooling**

```bash
git add .gitignore package.json package-lock.json scripts/video/capture-demo.ts scripts/video/README.md
git commit -m "feat: capture real operation demo"
```

### Task 3: Render MP4 with a legal generated music bed

**Files:**
- Create: `scripts/video/render-demo.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/video/README.md`

**Interfaces:**
- Consumes: `artifacts/video/spinner-laser-kit-demo-silent.webm`.
- Produces: `artifacts/video/spinner-laser-kit-demo-zh-hant.mp4` with H.264 video and low-volume AAC audio.
- Command: `npm run video:render`.

- [ ] **Step 1: Add the pinned local renderer**

Run: `npm install --save-dev --save-exact ffmpeg-static`

Expected: `package.json` and `package-lock.json` record an exact version and `node_modules/ffmpeg-static/ffmpeg` exists. No system-wide package is installed.

- [ ] **Step 2: Implement deterministic rendering**

Resolve the binary exported by `ffmpeg-static`. Build a quiet ambient bed from three generated sine sources at 220 Hz, 277.18 Hz, and 329.63 Hz, each volume-limited and faded in/out; mix them below normal speech level. Combine that audio with the captured WebM using `libx264`, `-pix_fmt yuv420p`, `-movflags +faststart`, AAC 128 kbps, and `-shortest`. Preserve the original silent WebM.

- [ ] **Step 3: Add and run the render command**

Add `"video:render": "node scripts/video/render-demo.mjs"` to `package.json` and run `npm run video:render`.

Expected: a non-empty `spinner-laser-kit-demo-zh-hant.mp4` is created and ffmpeg exits zero.

- [ ] **Step 4: Commit renderer tooling**

```bash
git add package.json package-lock.json scripts/video/render-demo.mjs scripts/video/README.md
git commit -m "feat: render captioned demo video"
```

### Task 4: Verify the finished artifact and hand it off

**Files:**
- Create: `scripts/video/verify-demo.mjs`
- Modify: `package.json`
- Modify: `scripts/video/README.md`

**Interfaces:**
- Consumes: final MP4, silent WebM, and capture manifest.
- Produces: a zero exit code plus a JSON verification summary with `width`, `height`, `durationSeconds`, `videoCodec`, `audioCodec`, `sceneCount`, and `privacyPass`.
- Command: `npm run video:verify`.

- [ ] **Step 1: Implement metadata and privacy verification**

Invoke the pinned ffmpeg binary with `-i` and parse its diagnostic metadata. Require width 1920, height 1080, duration 160–200 seconds, H.264 video, AAC audio, thirteen ordered scene IDs, and no absolute local path or email pattern in `capture-manifest.json`. Decode the full MP4 to a null sink so truncated or corrupt output fails.

- [ ] **Step 2: Add the verification command**

Add `"video:verify": "node scripts/video/verify-demo.mjs"` and `"video:make": "npm run video:capture && npm run video:render && npm run video:verify"` to `package.json`.

- [ ] **Step 3: Run video and project verification**

Run:

```bash
npm run video:verify
npm test -- --run
npm run typecheck
npm run build
git status --short
```

Expected: video verification reports 1920×1080, 160–200 seconds, H.264/AAC, thirteen scenes, and `privacyPass: true`; 425 or more unit tests pass; typecheck and build pass; Git status shows no generated video and shows the Knight STL only as the pre-existing untracked file.

- [ ] **Step 4: Manually inspect representative frames and audio level**

Extract frames at 5, 30, 70, 115, 145, and 170 seconds into `artifacts/video/review/`, inspect them for readable Traditional Chinese captions and absence of personal data, and play the MP4 to confirm the music is audible but unobtrusive. If the actual duration is shorter than 170 seconds, use the final scene timestamp from the manifest instead of seeking past EOF.

- [ ] **Step 5: Commit verification tooling**

```bash
git add package.json package-lock.json scripts/video/verify-demo.mjs scripts/video/README.md
git commit -m "test: verify demo video artifact"
```

- [ ] **Step 6: Deliver both local artifacts**

Provide clickable links to `artifacts/video/spinner-laser-kit-demo-zh-hant.mp4` and `artifacts/video/spinner-laser-kit-demo-silent.webm`, state the measured duration and resolution, and note that the Knight Fortress source remains local and uncommitted.

