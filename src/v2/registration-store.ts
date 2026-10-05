import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A terminal watch that outlives the plugin instance that created it. */
export interface StoredRegistration {
  readonly ptyID: string
  readonly sessionID: string
  readonly notificationID: string
  readonly notifyOnExit: boolean
  readonly notifyOnOutput: boolean
  readonly outputTail: number
}

export interface RegistrationStore {
  /** Identifies the OpenCode server the registrations belong to. */
  readonly key: string
  load(): StoredRegistration[]
  /** Merges one monitor's changes into the stored set; other monitors' records stay untouched. */
  apply(upserts: readonly StoredRegistration[], removals: readonly string[]): void
}

export function registrationKey(sessionID: string, ptyID: string): string {
  return JSON.stringify([sessionID, ptyID])
}

function valid(value: unknown): value is StoredRegistration {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.ptyID === 'string' &&
    record.ptyID !== '' &&
    typeof record.sessionID === 'string' &&
    record.sessionID !== '' &&
    typeof record.notificationID === 'string' &&
    record.notificationID !== '' &&
    typeof record.notifyOnExit === 'boolean' &&
    typeof record.notifyOnOutput === 'boolean' &&
    typeof record.outputTail === 'number' &&
    Number.isInteger(record.outputTail) &&
    record.outputTail >= 0
  )
}

function merge(
  current: readonly StoredRegistration[],
  upserts: readonly StoredRegistration[],
  removals: readonly string[]
): StoredRegistration[] {
  const merged = new Map(
    current.map((record) => [registrationKey(record.sessionID, record.ptyID), record])
  )
  for (const key of removals) merged.delete(key)
  for (const record of upserts) merged.set(registrationKey(record.sessionID, record.ptyID), record)
  return [...merged.values()]
}

export function memoryRegistrationStore(key = 'memory'): RegistrationStore {
  let records: StoredRegistration[] = []
  return {
    key,
    load: () => [...records],
    apply: (upserts, removals) => {
      records = merge(records, upserts, removals)
    },
  }
}

export function defaultStateDirectory(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'opencode-pty')
}

/** One file per OpenCode server, so two servers on a host never adopt each other's terminals. */
export function fileRegistrationStore(serverUrl: string, directory?: string): RegistrationStore {
  const key = serverUrl.replace(/\/+$/, '')
  const name = `registrations-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`
  const path = join(directory ?? defaultStateDirectory(), name)
  const load = (): StoredRegistration[] => {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter(valid) : []
  }
  return {
    key,
    load,
    apply: (upserts, removals) => {
      let current: StoredRegistration[] = []
      try {
        current = load()
      } catch {
        // An unreadable file is replaced by the live set rather than blocking every later write.
      }
      mkdirSync(join(path, '..'), { recursive: true })
      const next = `${path}.${process.pid}.tmp`
      writeFileSync(next, JSON.stringify(merge(current, upserts, removals)))
      renameSync(next, path)
    },
  }
}
