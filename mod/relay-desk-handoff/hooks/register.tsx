import type { EngineInterface, Register } from 'claude-code'

import { buildResumeUrl, openerArgv } from './relayUrl'

const LABEL = 'Continue in Relay Desk'
const OPEN_TIMEOUT_MS = 15_000

let isOpening = false

// session.id() is the transcript file's name (the UUID `--resume` takes); session.root() is the
// directory the session started in, which is where its transcript is stored. A shell `cd` moves
// session.cwd() but not root().
async function handOff($: EngineInterface): Promise<string> {
  if (isOpening) return 'Relay Desk is already opening; please wait.'
  isOpening = true
  try {
    let sessionId: string
    let root: string
    try {
      sessionId = await $.session.id()
      root = await $.session.root()
    } catch {
      return 'Could not read the ID or the folder of this conversation, so it cannot be handed to Relay Desk.'
    }
    const built = buildResumeUrl(sessionId, root)
    if (!built.ok) return built.reason
    const argv = openerArgv(await $.env.get('SystemRoot'), built.url)
    if (argv === null) return 'Relay Desk runs only on Windows; this computer cannot open relaydesk:// links.'
    try {
      const ran = await $.process.run(argv, { timeoutMs: OPEN_TIMEOUT_MS })
      if (ran.exitCode !== 0) return `Windows could not open Relay Desk (exit code ${ran.exitCode}). Check that Relay Desk is installed.`
    } catch {
      return 'Could not start the Windows link handler; Relay Desk may not have opened.'
    }
    return 'Handed this conversation to Relay Desk. Do not type here while Relay Desk has it; to continue here, first press “Hand back to desktop” in Relay Desk.'
  } finally {
    isOpening = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'relay', description: 'Continue this conversation in Relay Desk (does not start a Claude turn)' })
    } catch (error) {
      $.ui.log(`/relay could not be registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'relay' }, async $ => ({ text: await handOff($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Never offer a take-over while a turn runs here (one writer per session) or over a survey.
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const theirs = await next(e)

    return (
      <Box flexDirection="row" columnGap={1}>
        <Button key="relay-desk-handoff" label={LABEL} onPress={async () => $.ui.toast(await handOff($))} />
        {theirs}
      </Box>
    )
  })
}
