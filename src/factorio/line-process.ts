import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type Frame = Record<string, unknown>

class AsyncFrames {
  private readonly values: Frame[] = []
  private readonly waiters: Array<{
    resolve: (value: Frame) => void
    reject: (error: Error) => void
  }> = []
  private terminalError: Error | undefined

  push(value: Frame): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(value)
    else this.values.push(value)
  }

  fail(error: Error): void {
    this.terminalError = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  next(): Promise<Frame> {
    const value = this.values.shift()
    if (value) return Promise.resolve(value)
    if (this.terminalError) return Promise.reject(this.terminalError)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
}

export class JsonLineProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly frames = new AsyncFrames()
  private stderr = ''

  constructor(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    readonly label: string,
  ) {
    this.child = spawn(executable, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        const frame = JSON.parse(line) as unknown
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          throw new Error('frame is not an object')
        }
        this.frames.push(frame as Frame)
      } catch (error) {
        this.frames.fail(
          new Error(`${this.label} emitted invalid protocol JSON: ${line.slice(0, 300)}`, {
            cause: error,
          }),
        )
      }
    })
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384)
    })
    this.child.once('error', error => this.frames.fail(error))
    this.child.once('exit', (code, signal) => {
      this.frames.fail(
        new Error(
          `${this.label} exited code=${String(code)} signal=${String(signal)}\n${this.stderr}`,
        ),
      )
    })
  }

  send(frame: Frame): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  receive(): Promise<Frame> {
    return this.frames.next()
  }

  async close(frame: Frame, timeoutMs = 5_000): Promise<void> {
    if (this.child.exitCode !== null) return
    this.send(frame)
    await Promise.race([
      this.receive().catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ])
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
  }
}
