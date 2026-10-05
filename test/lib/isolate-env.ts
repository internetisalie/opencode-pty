import { join } from 'node:path'

// The file registration store defaults to the user's state directory and to OPENCODE_PTY_SERVER_URL.
// Tests must never read or write the real ones.
process.env.XDG_STATE_HOME = join(
  process.cwd(),
  'node_modules',
  '.cache',
  'opencode-pty-test-state'
)
delete process.env.OPENCODE_PTY_SERVER_URL
