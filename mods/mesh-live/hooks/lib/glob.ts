/** Turns a repo-relative glob into a RegExp: `**` spans directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*' && glob[i + 1] === '*') {
      const isSegment = glob[i + 2] === '/'
      source += isSegment ? '(?:.*/)?' : '.*'
      i += isSegment ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

const clean = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '')

/**
 * Whether `path` (repo-relative, or absolute when outside the repo) falls under
 * a task's `files` entry: an exact file, a directory ending in "/", or a glob.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const p = clean(pattern.trim())
  const f = clean(path)
  if (p === '') return false
  if (/[*?]/.test(p)) return globToRegExp(p).test(f) || globToRegExp(`**/${p}`).test(f)
  if (p.endsWith('/')) return f.startsWith(p) || f.includes(`/${p}`)
  return f === p || f.endsWith(`/${p}`)
}

/** `path` relative to `root` when it lies under it, else unchanged. */
export function relativeTo(root: string, path: string): string {
  const base = clean(root).replace(/\/+$/, '')
  const full = clean(path)
  return base !== '' && full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full
}
