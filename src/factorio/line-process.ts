import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

type Frame = Record<string, unknown>

export interface ReceiveOptions {
  timeoutMs: number
  code: string
  stateCertainty?: 'unchanged' | 'confirmed' | 'uncertain'
}

export interface ProcessLimits {
  memoryBytes?: number
}

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
  private memoryTimer: NodeJS.Timeout | undefined
  private memoryCheckRunning = false

  constructor(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    readonly label: string,
    limits: ProcessLimits = {},
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
      if (this.memoryTimer) clearInterval(this.memoryTimer)
      this.frames.fail(
        new Error(
          `${this.label} exited code=${String(code)} signal=${String(signal)}\n${this.stderr}`,
        ),
      )
    })
    if (limits.memoryBytes !== undefined) {
      this.memoryTimer = setInterval(() => {
        if (this.memoryCheckRunning || this.child.exitCode !== null || this.child.killed) return
        const pid = this.child.pid
        if (pid === undefined) return
        this.memoryCheckRunning = true
        execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)], (error, stdout) => {
          this.memoryCheckRunning = false
          if (error || this.child.exitCode !== null || this.child.killed) return
          const rssKiB = Number.parseInt(stdout.trim(), 10)
          if (Number.isFinite(rssKiB) && rssKiB * 1_024 > limits.memoryBytes!) {
            const resourceError = Object.assign(
              new Error(
                `${this.label} exceeded ${limits.memoryBytes} byte resident-memory limit`,
              ),
              { code: 'KERNEL_RESOURCE_EXHAUSTED', stateCertainty: 'unchanged' as const },
            )
            this.frames.fail(resourceError)
            this.child.kill('SIGKILL')
          }
        })
      }, 100)
      this.memoryTimer.unref()
    }
  }

  send(frame: Frame): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  async receive(options?: ReceiveOptions): Promise<Frame> {
    if (!options) return this.frames.next()
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.frames.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(
              new Error(`${this.label} exceeded ${options.timeoutMs}ms execution limit`),
              {
                code: options.code,
                ...(options.stateCertainty === undefined
                  ? {}
                  : { stateCertainty: options.stateCertainty }),
              },
            )
            this.child.kill('SIGKILL')
            reject(error)
          }, options.timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async close(frame: Frame, timeoutMs = 5_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return
    this.send(frame)
    await Promise.race([
      this.receive().catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ])
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
  }
}
