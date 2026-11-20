import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** Tiny atomic JSON file store under userData. */
export class JsonStore<T extends object> {
  private file: string
  private cache: T | null = null
  private defaults: T

  constructor(name: string, defaults: T) {
    this.file = join(app.getPath('userData'), name)
    this.defaults = defaults
  }

  get path(): string {
    return this.file
  }

  read(): T {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<T>
        this.cache = { ...this.defaults, ...parsed }
        return this.cache
      }
    } catch {
      /* corrupt file, fall through to defaults */
    }
    this.cache = structuredClone(this.defaults)
    return this.cache
  }

  write(data: T): void {
    this.cache = data
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  update(fn: (cur: T) => T): T {
    const next = fn(this.read())
    this.write(next)
    return next
  }
}
