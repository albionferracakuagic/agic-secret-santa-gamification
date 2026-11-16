/** Avatar = preset id (contract: no uploads). Glyphs are decorative; the id is what is stored. */
export const AVATAR_GLYPH: Record<string, string> = {
  santa: '🎅',
  mrs_claus: '🤶',
  elf: '🧝',
  reindeer: '🦌',
  snowman: '⛄',
  tree: '🎄',
  star: '⭐',
  bell: '🔔',
};
export const avatarGlyph = (id: string | null) => (id && AVATAR_GLYPH[id]) || '🎅';
