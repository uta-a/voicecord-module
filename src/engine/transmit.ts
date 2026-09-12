/**
 * 送信ゲート。「再生中だけ常に送信」を実装する。
 *
 * 移植元（desktop/src/main/engine/transmit.ts）から**論理を一切変えずに**持ってくる。
 * ここのタイマー構成は実機の事故から生まれたもので、コメントごと保存する価値がある。
 *
 * 依存は Injector の 3 メソッドだけなので、テストではフェイクを渡せる。
 */

/** ゲートが叩く先。Injector の一部だけを要求する */
export interface GateTarget {
  gateOpen(): void
  gateClose(): void
  /** 強制送信フラグだけ下ろす（解放済み Connection* を触らない） */
  gateReset(): void
}

export interface GateTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

const realTimers: GateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface GateOptions {
  enabled?: boolean
  /** 停止してから閉じるまでの遅延。連続再生の隙間で無駄に閉じないため */
  revertDelayMs?: number
  /**
   * vc=inactive がこの時間継続して初めて「VC 退出」と確定する。
   * 連打時は frida VM ロック飽和で hb が一瞬途切れ、hook が一過性の vc=false を出す。
   * それで即 clearForced すると doClose 予約が破棄され、かつ SetPTTActive(0) も
   * 呼ばれず常時送信が stuck になる。revertDelayMs より長くして誤確定を防ぐ。
   */
  vcRevertDelayMs?: number
  onStatus?: (m: string) => void
  timers?: GateTimers
}

export class FridaGate {
  private open = false
  /** hook.js の activity のミラー。VC 復帰時に開き直すか判断するのに使う */
  private playing = false
  private timer: unknown = null
  private vcTimer: unknown = null
  private guardTimer: unknown = null

  readonly enabled: boolean
  private readonly revertDelayMs: number
  private readonly vcRevertDelayMs: number
  private readonly onStatus: ((m: string) => void) | null
  private readonly timers: GateTimers

  constructor(
    private readonly inj: GateTarget,
    opts: GateOptions = {}
  ) {
    this.enabled = opts.enabled ?? true
    this.revertDelayMs = opts.revertDelayMs ?? 1000
    this.vcRevertDelayMs = opts.vcRevertDelayMs ?? 2500
    this.onStatus = opts.onStatus ?? null
    this.timers = opts.timers ?? realTimers
  }

  /** テストと診断用。内部状態を覗く */
  get isOpen(): boolean {
    return this.open
  }
  get isPlaying(): boolean {
    return this.playing
  }

  /**
   * 再生に先立ってゲートを開く（入場音の頭欠け防止）。
   *
   * ゲートは GetStats で Connection* を捕捉するまで実際には噛まないため、
   * 再生と同時に開いたのでは頭が送信されない。
   * guardMs 以内に activity が来なければ閉じる。activity は変化時にしか出ないので、
   * これが無いと再生が始まらなかった場合に常時送信が開きっぱなしになる。
   */
  preOpen(guardMs: number): void {
    if (!this.enabled) return
    this.cancelTimer()
    this.cancelGuardTimer()
    if (!this.open) {
      this.safe(() => this.inj.gateOpen())
      this.open = true
      this.status('gate open (pre)')
    }
    this.guardTimer = this.timers.setTimeout(() => {
      this.guardTimer = null
      this.doClose()
    }, guardMs)
  }

  onActivity(playing: boolean): void {
    if (!this.enabled) return
    this.playing = playing
    if (playing) {
      this.cancelTimer()
      // 再生が始まったので先行オープンのガードは不要
      this.cancelGuardTimer()
      if (!this.open) {
        this.safe(() => this.inj.gateOpen())
        this.open = true
        this.status('gate open (frida)')
      }
      return
    }
    // 停止直後は revert せず、遅延させて連続再生に備える。
    // VC 退出由来の activity=false でもそのまま予約してよい。解放済み Connection* への
    // 書き込みは hook 側が退出時に gateConn を捨てることで塞いであり（applyGate が
    // no-op になる）、gateClose 自体は届いて gateForced を下ろしてくれるので、むしろ
    // 予約した方が「VC へ戻ったら常時送信が復活する」経路を確実に消せる。
    this.cancelTimer()
    this.timer = this.timers.setTimeout(() => this.doClose(), this.revertDelayMs)
  }

  /**
   * VC の在席／退出通知。
   *
   * active=false が vcRevertDelayMs 継続したときだけ退出と確定して clearForced する。
   * 連打由来の一過性 vc=false では確定前に active へ戻るため、予約済みの doClose が
   * 生き残り、ゲートは正常にクローズする。
   */
  onVcActive(active: boolean): void {
    if (active) {
      this.cancelVcTimer()
      if (this.playing && !this.open) {
        // 一過性の vc=false を退出と誤確定して clearForced した後、実は VC が
        // 生きていたケース。まだ再生中なら開き直す
        this.safe(() => this.inj.gateOpen())
        this.open = true
        this.status('gate reopen (vc back)')
      } else if (!this.playing && this.open) {
        // VC が戻ったのに鳴っていない = 退出中に hook 側でボイスが破棄された。
        // この gateClose は hook がまだ新しい Connection* を捕捉していなければ
        // no-op だが、gateForced は下りるので、直後の GetStats が新ポインタで
        // 無条件クローズしてくれる
        this.doClose()
      }
      return
    }
    this.cancelVcTimer()
    this.vcTimer = this.timers.setTimeout(() => {
      this.vcTimer = null
      this.clearForced()
    }, this.vcRevertDelayMs)
  }

  /**
   * セッション境界（attach / detach / detached）の後始末。
   *
   * playing は hook.js の voices 有無のミラーなので、hook が消える／入れ替わるときに
   * 必ず落とす。落とし忘れると activity=false が二度と来ないまま playing=true が残り、
   * 再アタッチ後に VC へ入った瞬間 onVcActive の「まだ再生中なら開き直す」分岐が
   * 成立して、何も再生していないのにゲートが開く。
   */
  revertNow(): void {
    this.cancelTimer()
    this.cancelVcTimer()
    this.cancelGuardTimer()
    this.safe(() => this.inj.gateClose())
    this.open = false
    this.playing = false
    this.status('gate close (frida)')
  }

  /**
   * VC 退出時の安全な後始末。
   * SetPTTActive を呼ばず（解放済み Connection* を触らない）、強制送信フラグだけ
   * 落として次回入室での常時送信復活を防ぐ。
   */
  clearForced(): void {
    this.cancelTimer()
    this.cancelVcTimer()
    this.cancelGuardTimer()
    this.open = false
    // VC 退出が確定 = 鳴っていたボイスも hook 側で破棄済み
    this.playing = false
    this.safe(() => this.inj.gateReset())
    this.status('gate reset (vc left)')
  }

  private doClose(): void {
    this.cancelGuardTimer()
    this.safe(() => this.inj.gateClose())
    this.open = false
    this.status('gate close (frida)')
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    this.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private cancelVcTimer(): void {
    if (this.vcTimer === null) return
    this.timers.clearTimeout(this.vcTimer)
    this.vcTimer = null
  }

  private cancelGuardTimer(): void {
    if (this.guardTimer === null) return
    this.timers.clearTimeout(this.guardTimer)
    this.guardTimer = null
  }

  private safe(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      this.status('gate error: ' + String(e))
    }
  }

  private status(m: string): void {
    try {
      this.onStatus?.(m)
    } catch {
      // 通知先が落ちてもゲートは動かし続ける
    }
  }
}
