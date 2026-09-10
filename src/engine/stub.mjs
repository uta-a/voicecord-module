/**
 * スタブエンジン（M2）。
 *
 * frida は入れない。M2 の目的は「patcher ↔ engine ↔ preload ↔ UI の配線が
 * 端から端まで通ること」の実証なので、ここでは hook.js が吐くはずのイベントを
 * それらしく合成して返す。M3 でこのファイルが本物の engine.mjs に置き換わる。
 *
 * utilityProcess の子として起きるので、親との通信は process.parentPort。
 * ここで throw しても Discord は死なないが、落ちれば patcher が再起動する
 * （その再起動が働くことも M2 の完了判定に入っている）。
 */

/** hook.js の 1 フレーム。48kHz / mono / 480 サンプル ≒ 100Hz */
const SAMPLE_RATE = 48000

/** audio utility を見つけたことにするまでの間。実機の「VC に入るまで待つ」に相当 */
const ATTACH_DELAY_MS = 1500

/** 見つけたことにする PID。実機では enumerateProcesses が返す */
const FAKE_PID = 4242

const port = process.parentPort

function post(msg) {
  try {
    port.postMessage(msg)
  } catch (e) {
    // 親が先に死んでいる。ここで投げても誰も受け取らないのでログだけ
    console.error('[stub] 親へ送れませんでした', e)
  }
}

const emit = (payload) => post({ t: 'ev', payload })
const setState = (state, attachedPid = null, error = null) =>
  post({ t: 'state', state, attachedPid, error })

/** preload で受け取った PCM の長さ。play の再生時間に使う */
const pcmSamples = new Map()

let voiceSeq = 0
const playing = new Map()
let calibTimer = null
let gateOpen = false

function durationMs(key) {
  const n = pcmSamples.get(key)
  if (typeof n === 'number' && n > 0) return (n / SAMPLE_RATE) * 1000
  return 1200
}

function openGate() {
  if (gateOpen) return
  gateOpen = true
  emit({ ev: 'gate', open: true })
}

function closeGateIfIdle() {
  if (playing.size > 0 || !gateOpen) return
  gateOpen = false
  emit({ ev: 'gate', open: false })
}

function endVoice(voiceId) {
  const t = playing.get(voiceId)
  if (t !== undefined) clearTimeout(t)
  playing.delete(voiceId)
  emit({ ev: 'voiceEnded', voiceId })
  closeGateIfIdle()
}

function stopCalib() {
  if (calibTimer === null) return
  clearInterval(calibTimer)
  calibTimer = null
}

/** 声らしいレベル（-24 dBFS 前後）の計測値をでっち上げる */
function measure(tag, done, budget, master) {
  return {
    tag,
    frames: done,
    budget,
    total: done * 480,
    clip: 0,
    master,
    txGain: 0.25,
    vRms: 0.063,
    vPeak: 0.21,
    vN: done * 300,
    iRms: 0,
    iPeak: 0,
    iN: 0,
    vNow: 0.05 + Math.random() * 0.05,
    iNow: 0
  }
}

let master = 1.0

/**
 * 要求の処理。ここに無いチャンネルは patcher 側で処理されるので、
 * ここに来た時点で配線の間違い。黙って undefined を返さず理由を返す。
 */
const handlers = {
  'voicecord:reattach': () => {
    setState('searching', null, null)
    setTimeout(() => setState('attached', FAKE_PID, null), ATTACH_DELAY_MS)
    return { ok: true, pid: FAKE_PID, label: 'スタブエンジン' }
  },

  'voicecord:detach': () => {
    emit({ ev: 'detached' })
    setState('searching', null, null)
  },

  'voicecord:preload': ([key, pcm]) => {
    // pcm は ArrayBuffer。長さだけ覚えて中身は捨てる（スタブは鳴らさない）
    const bytes = pcm instanceof ArrayBuffer ? pcm.byteLength : 0
    pcmSamples.set(key, bytes / 4)
    return { key, samples: bytes / 4 }
  },

  'voicecord:play': ([req]) => {
    const voiceId = `stub-v${++voiceSeq}`
    openGate()
    playing.set(
      voiceId,
      setTimeout(() => endVoice(voiceId), durationMs(req?.fp ?? req?.srcId ?? ''))
    )
    return voiceId
  },

  'voicecord:stop': ([voiceId]) => void endVoice(voiceId),

  'voicecord:stopAll': () => {
    for (const voiceId of [...playing.keys()]) endVoice(voiceId)
  },

  'voicecord:setVoiceVolume': () => {},

  'voicecord:setMaster': ([v]) => {
    master = Number(v)
  },

  'voicecord:openGate': ([guardMs]) => {
    openGate()
    // 再生が始まらなければ自分で閉じる。実機と同じく開けっぱなしにしない
    setTimeout(() => closeGateIfIdle(), Number(guardMs) || 1500)
  },

  'voicecord:calibStart': ([tag, frames]) => {
    stopCalib()
    let done = 0
    // 実機は 100 フレーム ≒ 1 秒。100ms ごとに 10 フレーム進める
    calibTimer = setInterval(() => {
      done = Math.min(frames, done + 10)
      if (done < frames) {
        emit({ ev: 'calib', ...measure(tag, done, frames, master) })
        return
      }
      stopCalib()
      emit({
        ev: 'calibDone',
        ...measure(tag, done, frames, master),
        vBlocks: Array.from({ length: 40 }, () => 0.004)
      })
    }, 100)
  },

  'voicecord:calibStop': () => stopCalib()
}

port.on('message', (e) => {
  const msg = e?.data
  if (msg === null || typeof msg !== 'object' || msg.t !== 'req') return
  const { id, ch, args } = msg
  const fn = handlers[ch]
  if (fn === undefined) {
    post({ t: 'res', id, ok: false, error: `${ch} はエンジンの担当ではありません（配線の誤り）` })
    return
  }
  try {
    post({ t: 'res', id, ok: true, value: fn(Array.isArray(args) ? args : []) })
  } catch (err) {
    post({ t: 'res', id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

// 親が消えたら後始末して終わる。実機ではここでゲートを閉じる（復帰 4 層の 1 層目）
port.on('close', () => {
  stopCalib()
  for (const t of playing.values()) clearTimeout(t)
  process.exit(0)
})

// 起動直後は「生きているが audio utility 未検出」。VC に入るまではこれが正常
setState('searching', null, null)
setTimeout(() => setState('attached', FAKE_PID, null), ATTACH_DELAY_MS)

// VC 在席とゲート情報が attach の少し後に届く、という実機の順番に合わせる
setTimeout(() => emit({ ev: 'vc', active: true }), ATTACH_DELAY_MS + 200)
setTimeout(() => emit({ ev: 'gateInfo', conn: '0x0000stub' }), ATTACH_DELAY_MS + 400)

console.log('[stub] スタブエンジンを起動しました（frida は入っていません）')
