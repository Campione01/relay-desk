import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'relay-desk-handoff'
const SESSION = '0F8FAD5B-D9CB-469F-A165-70867728950E'
const ROOT = 'C:\\Users\\me\\Projects\\a b&c'
const RESUME_URL =
  'relaydesk://resume?session=0f8fad5b-d9cb-469f-a165-70867728950e&cwd=C%3A%5CUsers%5Cme%5CProjects%5Ca%20b%26c'
const OPENER = ['C:\\Windows\\System32\\rundll32.exe', 'url.dll,FileProtocolHandler', RESUME_URL]

// /relay typed at the desktop's prompt, as the engine stamps it.
const RELAY = { command: 'relay', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const band = (isWorking: boolean) =>
  ({
    plugin: PLUGIN,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

// The engine beneath the plugin: session facts, the opener and the toasts, all recorded.
function world(on: On, root: string = ROOT) {
  const runs: (readonly string[])[] = []
  const toasts: string[] = []
  const registered: string[] = []
  mock.env(on, { SystemRoot: 'C:\\Windows' })
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: root }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  return { runs, toasts, registered }
}

test('/relay opens the resume URL through the shell protocol handler, no command interpreter', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  expect(w.registered).toEqual(['relay'])
  const ran = await $.command.run(RELAY)
  expect(w.runs).toEqual([OPENER])
  expect(ran.text ?? '').toMatch(/^Handed this conversation to Relay Desk\. .*“Hand back to desktop”/)
})

test('the band button opens the same URL on the desktop and the terminal', async ($, on) => {
  const w = world(on)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...band(false), surface })
    expect((await ui.find({ key: 'relay-desk-handoff' }))?.type).toBe('Button')
    await ui.press({ key: 'relay-desk-handoff' })
    await ui.unmount()
  }
  expect(w.runs).toEqual([OPENER, OPENER])
  expect(w.toasts.length).toBe(2)
  expect(w.toasts[0]).toMatch(/^Handed this conversation to Relay Desk\. .*“Hand back to desktop”/)
})

test('the band offers no take-over while a turn runs', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...band(true), surface: 'desktop' })
  expect(await ui.find({ key: 'relay-desk-handoff' })).toBeUndefined()
  await ui.unmount()
})

test('a network folder is refused before anything starts', async ($, on) => {
  const w = world(on, '\\\\server\\share\\project')
  const ran = await $.command.run(RELAY)
  expect(w.runs).toEqual([])
  expect(ran.text ?? '').toMatch(/network paths are not supported/)
})
