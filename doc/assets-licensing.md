# Assets licensing policy

Scope: everything that ships in the web app (`apps/web`): images, audio, fonts, animations and bundled
third-party libraries. Backed by `apps/web/src/fx/assets.manifest.json`, enforced by
`apps/web/src/fx/assets.test.ts` (runs in `npm test`, therefore in CI).

## Allowed

| License | Rule |
|---|---|
| CC0-1.0, Public Domain (`LicenseRef-PublicDomain`) | Free to use; still recorded. |
| MIT, ISC | Keep the license text (`licenses/` snapshot). |
| Apache-2.0 | Keep the license text and the copyright notice (shown on `/credits`). |
| OFL-1.1 (fonts) | Keep copyright + license; do not sell the font alone; Reserved Font Names respected (subsetting is allowed and recorded as `modified: true`). |
| CC-BY-4.0 | **Only** if `attributionRequired: true` with an `attributionText`, and the credits page can show it. |

## Forbidden

Non-commercial (NC), no-derivatives (ND), GPL/AGPL/LGPL assets, CC-BY-SA (share-alike),
unclear/unknown/"free for personal use", AI-generated media, and any carol recordings
(sound recordings of known songs carry separate performance/master rights; our music is an
original procedural arpeggio). The test fails the build if one of these appears.

## Manifest fields (`assets.manifest.json`)

| Field | Meaning |
|---|---|
| `id` | Unique, e.g. `font.nunito.400`. |
| `type` | audio, image, font, code, library, lottie. |
| `file` | Path relative to `apps/web` (code-generated assets point at the generating source file). |
| `source` | Where it came from (URL / package + version / "procedural"). |
| `author` | Copyright holder. |
| `license` | SPDX identifier. |
| `licenseUrl` | Canonical license URL. |
| `retrievedAt` | Date it was obtained (YYYY-MM-DD). |
| `licenseSnapshot` | File under `apps/web/licenses/` holding the license text as obtained. |
| `attributionRequired` | `true` ⇒ listed on `/credits` with `attributionText`. |
| `attributionText` | Exact credit line. |
| `modified` | `true` if we changed it (e.g. font subsetting). |
| `sha256` | Hash of the shipped file (verified by the test for everything under `public/`; `null` for code). |
| `approvedBy` | Who approved the entry. Non-CC0 additions need owner sign-off before merging. |

## Adding an asset

1. Put the file under `apps/web/public/assets/...`.
2. Copy the license text to `apps/web/licenses/` and add a manifest entry with every field.
3. `npm test` must pass: every file in `public/` has an entry whose hash matches.
4. If `attributionRequired` or the license is OFL/Apache, it appears on `/credits` automatically.

## Current assets

- Fonts, self-hosted and subset to Basic Latin + Latin-1 (+ typographic quotes, dashes, €):
  **Nunito** 400/700 (OFL-1.1) for body text; **Mountains of Christmas** 400/700 for display
  headings. Mountains of Christmas is published under **Apache-2.0** (not OFL) by its authors; it
  is on the allowed list and its notice is on `/credits`. Italian accents (àèéìòù/ÀÈÉÌÒÙ) were
  verified present in every subset file.
- Sounds and music are generated in code (CC0). Emoji are rendered by the operating system font
  (no files shipped). Libraries: canvas-confetti (ISC), howler (MIT).
- No Lottie/dotLottie animations are shipped. If one is added, it needs a manifest entry
  (`type: "lottie"`) and appears on `/credits` with its notice.
