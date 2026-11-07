// Every playable scenario, one file each under ./entries/ (`<id>.ts`,
// `export default` a Playable). A directory rather than one array so two
// branches adding scenarios the same afternoon never touch the same line —
// the same reason src/ui/releaseNotes/ is a directory.
//
// Add one with the `.claude/skills/test-scenarios` skill.

import { SECTIONS, type Playable, type Section } from './types'

const modules = import.meta.glob('./entries/*.ts', { eager: true, import: 'default' }) as Record<string, unknown>

/** The entry file a module came from: `./entries/quickdraw.ts` → `quickdraw`. */
export const fileId = (path: string): string => path.replace(/^.*\/([^/]+)\.ts$/, '$1')

const ORDER = Object.keys(SECTIONS) as Section[]

/** All entries, grouped by section in list order, then by title. */
export const PLAYABLES: readonly Playable[] = Object.values(modules)
  .map((m) => m as Playable)
  .sort((a, b) => ORDER.indexOf(a.section) - ORDER.indexOf(b.section) || a.title.localeCompare(b.title))

/** Each entry with the file it was loaded from (the registry test checks they agree). */
export const ENTRY_FILES: readonly { file: string; entry: Playable }[] = Object.entries(modules).map(([path, m]) => ({
  file: fileId(path),
  entry: m as Playable,
}))

export const findPlayable = (id: string): Playable | undefined => PLAYABLES.find((p) => p.id === id)
