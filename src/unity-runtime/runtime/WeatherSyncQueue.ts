import type { RuntimeWeatherConfig, WeatherState } from '../protocol/weather'

/** Latest complete snapshot; one apply in flight. Runtime status never enters SceneStore. */
export class WeatherSyncQueue {
  private target: RuntimeWeatherConfig | null = null
  private revision = 0
  private accepted = -1
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  private suspended = true
  private disposed = false
  private failed = false
  private listeners = new Set<() => void>()
  state: WeatherState | null = null
  error = ''
  constructor(private readonly apply: (config: RuntimeWeatherConfig | null, revision: number) => Promise<WeatherState>) {}
  get pending() { return this.revision !== this.accepted }
  get currentRevision() { return this.revision }
  get config() { return this.target }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed() { this.listeners.forEach(listener => listener()) }
  reset() {
    this.epoch++; this.cancelTimer(); this.target = null; this.revision = 0; this.accepted = -1
    this.state = null; this.error = ''; this.failed = false; this.changed()
  }
  set(config: RuntimeWeatherConfig | null, schedule = true) {
    const next = structuredClone(config)
    if (JSON.stringify(next) !== JSON.stringify(this.target)) { this.target = next; this.revision++; this.failed = false; this.error = '' }
    this.changed()
    if (schedule) this.schedule()
    return this.revision
  }
  suspend() { this.suspended = true; this.cancelTimer() }
  resume() { this.suspended = false; this.schedule() }
  acknowledge(revision: number, state?: WeatherState) {
    if (revision > this.revision || revision < this.accepted) return
    this.accepted = revision
    if (revision === this.revision && state) this.state = state
    this.changed()
  }
  acceptEvent(state: WeatherState) {
    if (state.weatherRevision !== this.revision) return
    this.state = state; this.changed()
  }
  retry() { this.failed = false; this.error = ''; this.accepted = -1; this.flush() }
  flush() { this.cancelTimer(); void this.drain() }
  private cancelTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  private schedule() {
    if (this.disposed || this.suspended || this.inFlight || this.failed || !this.pending || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain() }, 120)
  }
  private async drain() {
    if (this.disposed || this.suspended || this.inFlight || this.failed || !this.pending) return
    const revision = this.revision, epoch = this.epoch, config = structuredClone(this.target)
    this.inFlight = true
    try {
      const state = await this.apply(config, revision)
      if (!this.disposed && epoch === this.epoch) this.acknowledge(revision, state)
    } catch (error) {
      if (!this.disposed && epoch === this.epoch && revision === this.revision) {
        this.error = error instanceof Error ? error.message : String(error); this.failed = true; this.changed()
      }
    } finally { this.inFlight = false; this.schedule() }
  }
  dispose() { this.disposed = true; this.epoch++; this.cancelTimer(); this.listeners.clear() }
}
