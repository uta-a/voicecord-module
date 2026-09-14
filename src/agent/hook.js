// 常駐制御フック — KrispNCProcessFloat(discord_krisp.node) の出力バッファ(a3, post-Krisp)へ
// 複数音源をミックス注入する。Python から pcm/ctrl の2チャネルで実行時制御する。
//
// プロトコル (Python -> JS):
//   sc.post({type:"pcm", sourceId:"<id>"}, data=<f32le mono bytes>)   音源プリロード
//   sc.post({type:"ctrl", op:"play", voiceId, srcId, vol, loop, mode})
//   sc.post({type:"ctrl", op:"stop", voiceId})
//   sc.post({type:"ctrl", op:"stopAll"})
//   sc.post({type:"ctrl", op:"setVolume", voiceId, vol})
//   sc.post({type:"ctrl", op:"setMaster", vol})
//   sc.post({type:"ctrl", op:"setMode", voiceId, mode})
//   sc.post({type:"ctrl", op:"setLoop", voiceId, loop})
//   sc.post({type:"ctrl", op:"unload", srcId})
//   sc.post({type:"ctrl", op:"calibStart", tag, frames})              出力レベル計測の開始
//   sc.post({type:"ctrl", op:"calibStop"})                            同 中断
//
// イベント (JS -> Python): send({ev:...})
//   {ev:"ready"}                            フック設置完了
//   {ev:"loaded", srcId, samples}           音源プリロード完了
//   {ev:"activity", playing:bool}           再生中フラグ変化(常に送信トグルのトリガ)
//   {ev:"voiceEnded", voiceId, remaining}   ボイスがフェード完了で除去された
//   {ev:"calib", ...}                       計測の途中経過(~10Hz)
//   {ev:"calibDone", ...}                   計測完了(フレーム予算の消化 or calibStop)
//   {ev:"error", msg}                       エラー
//   {ev:"log", msg}                         デバッグログ

'use strict';

const MOD = "discord_krisp.node";
const EXPORT = "KrispNCProcessFloat";
const FRAME_MAX = 4096;      // cnt の安全ガード
const VOICE_MAX = 8;         // 同時再生ボイス上限(CPU保護)
const FADE = 0.0015;         // per-sample フェード係数(プチノイズ防止)
// 注入音の送信headroom。音源はフルスケール正規化されているため、相手側で声より遥かに
// 大きくならないよう固定減衰を掛ける(声=base には掛けない)。0.25 ≒ -12dB。
// この値は「話者の声が -26dBFS」という仮定と等価だが、実際はマイク・声量で変わる。
// そのズレは master(0..4, 1.0 = 0dB)で吸収する。上限 4.0 でちょうどこの減衰を打ち消すので、
// 定数側を編集しなくても調整レンジは全域カバーできる。実測は calibStart で行う。
const TX_GAIN = 0.25;
const MASTER_MAX = 4.0;      // = 1/TX_GAIN。master の上限(+12dB 相当 = 減衰ゼロ)
const VOL_MAX = 1.5;         // 音源別音量の上限(UI の 150% と一致させる)

// 制御メッセージの数値ガード。NaN/Infinity/負値/文字列が入ると clamp が効かず
// (NaN は > も < も false になる)、そのまま Krisp の出力バッファへ書き込まれてしまう。
// 到達経路は config.json の手編集や破損など。壊れた値は既定値へ倒す。
function num(v, dflt, max){
  const n = Number(v);
  if (!isFinite(n) || n < 0) return dflt;
  return n > max ? max : n;
}

// === プリロード済み音源: srcId -> {data: Float32Array, total: サンプル数(mono)} ===
// native バッファ(Memory.alloc + readFloat)ではなく JS の Float32Array で持つ。
// ミックスはサンプル毎に音源を読むため、native 境界を跨ぐと連打時に JS スレッドが飽和する。
const sources = Object.create(null);
// === アクティブボイス ===
// {voiceId, srcId, pos, vol, loop, mode("add"|"replace"), fadeGain, stopping}
let voices = [];
let master = 0.8;
let playing = false;        // 1つでも voice があるか(Python通知用)
let hb = 0;                 // VC在席ハートビート(onLeave 毎に増加)
let vcActive = false;       // VC通話中か(ハートビート監視で更新)

function log(m){ send({ev:"log", msg:m}); }

// ---- PCM プリロード受信(バイナリ同送)。recv はワンショットなので自己再登録 ----
function onPcm(msg, data){
  try {
    const id = msg.sourceId;
    if (!id || !data){ send({ev:"error", msg:"pcm: bad payload"}); }
    else {
      // recv の data はコールバック後の寿命が保証されないためコピーして保持する。
      const total = (data.byteLength / 4) | 0;
      const f32 = new Float32Array(total);
      f32.set(new Float32Array(data, 0, total));
      sources[id] = { data: f32, total: total };
      send({ev:"loaded", srcId:id, samples: total});
    }
  } catch(e){ send({ev:"error", msg:"onPcm: "+e}); }
  recv("pcm", onPcm);
}

// ---- 制御メッセージ受信(JSONのみ)。同じく自己再登録 ----
function eachVoice(voiceId, fn){ for (const v of voices) if (v.voiceId === voiceId) fn(v); }

function onCtrl(msg){
  try {
    switch(msg.op){
      case "play": {
        const s = sources[msg.srcId];
        // 再生を受理できない場合は voiceId 付きで拒否を通知する。これがないと Python 側が
        // 楽観的に作った「再生中」行が二度と消えず残留する(voiceEnded が来ないため)。
        if (!s){ send({ev:"playRejected", voiceId: msg.voiceId, reason:"no source "+msg.srcId}); break; }
        if (voices.length >= VOICE_MAX){ send({ev:"playRejected", voiceId: msg.voiceId, reason:"voice limit"}); break; }
        voices.push({
          voiceId: msg.voiceId, srcId: msg.srcId, pos: 0,
          vol: num(msg.vol, 1.0, VOL_MAX),
          loop: !!msg.loop, mode: (msg.mode || "add"),
          fadeGain: 0.0, stopping: false      // 0から立ち上げてフェードイン
        });
        break;
      }
      case "stop":      eachVoice(msg.voiceId, v => v.stopping = true); break;
      case "stopAll":   for (const v of voices) v.stopping = true; break;
      case "setVolume": eachVoice(msg.voiceId, v => v.vol = num(msg.vol, 1.0, VOL_MAX)); break;
      // master は 0..MASTER_MAX。1.0 が従来の 100%(0dB)で、上限 4.0 は TX_GAIN を
      // ちょうど打ち消す点(= 送信ヘッドルームによる減衰ゼロ)。
      // ここを超えさせないことで master*TX_GAIN <= 1.0 が保証されるので、
      // 「フルスケール以内の音源を 1 本だけ vol<=1.0 で鳴らす」限り注入音は歪まない。
      // 逆に言うとそれ以外(vol が 100% 超 / 同時に複数本)では clamp が効きうる。
      // 音量調整の推奨値は音源ピークを 0 dBFS 以内に抑える(calibration.ts の PEAK_CEIL_DBFS)
      // ので通常は当たらないが、手で上げた場合と重ね掛けは別。実際に当たったかは
      // calibStart の clip カウントで見える。
      case "setMaster": master = num(msg.vol, 0.8, MASTER_MAX); break;
      case "setMode":   eachVoice(msg.voiceId, v => v.mode = msg.mode); break;
      case "setLoop":   eachVoice(msg.voiceId, v => v.loop = !!msg.loop); break;
      case "unload":    delete sources[msg.srcId]; break;
      case "calibStart": calibStart(msg.tag, msg.frames); break;
      case "calibStop":  calibStop(); break;
      case "gateOpen":  gateOpen(); break;
      case "gateClose": gateClose(); break;
      // VC退出時など Connection* が解放済みかもしれない状況で、強制送信フラグだけを
      // 落とす(applyGate を呼ばないので解放済みポインタを触らず安全)。再入時に
      // 意図せず常時送信が復活するのを防ぐ。
      // gateApplied は「Discord 側に常時送信が残っているか」の記録なので落とさない。
      // 落とすと、VC退出が誤確定だった場合(連打で hb が停滞したケース)に SetPTTActive(0)
      // を呼ぶ機会が永久に失われ、喋りっぱなし判定のまま復帰できなくなる。
      // 誤確定なら GetStats が再開したときに下の自動クローズが効いて回復する。
      case "gateReset": gateForced = false; break;
      default:          send({ev:"error", msg:"unknown op "+msg.op});
    }
  } catch(e){ send({ev:"error", msg:"onCtrl: "+e}); }
  recv("ctrl", onCtrl);
}

recv("pcm", onPcm);
recv("ctrl", onCtrl);

// ============================================================================
// 送信ゲートの Frida 単体制御(CDP不要)。
// Discord 自身の Connection::SetPTTActive(active,b,p3) を呼んで常時送信を ON/OFF する。
//   SetPTTActive(conn, 1,0,0) → ctrl[0]=LLONG_MAX(常時送信ON)
//   SetPTTActive(conn, 0,0,0) → 通常VADへ復帰
// 生メモリ書込ではなく Discord の関数経由なので ctrl を整合的に設定でき、全ビルドで安全
// (生書込は Stable 等でレイアウト差により ACCESS_VIOLATION を起こしていた)。
// Connection* は Connection::GetStats(VC中1Hz発火)の第1引数で捕捉。関数はエクスポート名で解決。
// ============================================================================
const VOICE_MOD = "discord_voice.node";
let gateConn = null, gateForced = false, gateApplied = false;
// 直近に採用した Connection*。gateConn と違い VC退出(の誤検知)では捨てない。
// 「本当に接続が張り替わったのか、退出を誤検知してポインタだけ捨てたのか」を
// GetStats 側で区別するために持つ。
let gateLastConn = null;
// gateConn を捨てた時刻。同じアドレスを「誤検知からの復帰」として拾い直してよいのは
// この直後だけに限る(Node 側の vcRevertDelayMs と同程度)。それを過ぎた一致は、
// アドレスの再利用による別物の可能性が高いので新接続として扱う。
let gateDroppedAt = 0;
const GATE_READOPT_MS = 2500;
let setPTT = null;   // NativeFunction(Connection* this, bool active, bool b, bool p3)

function applyGate(on){
  if (!gateConn || !setPTT) return;   // 未捕捉なら GetStats 捕捉時に適用
  try {
    setPTT(gateConn, on ? 1 : 0, 0, 0);
    if (gateApplied !== on){ gateApplied = on; send({ev:"gate", open: on}); }
  } catch(e){ send({ev:"gateUnsafe", msg:"SetPTTActive 失敗: " + e}); }
}
function gateOpen(){ gateForced = true; applyGate(true); }
function gateClose(){ gateForced = false; applyGate(false); }

// スクリプトが外される直前の後始末(ゲート復帰の最短経路)。
// frida は host(VoiceCord のエンジン)が強制終了されて接続が切れたときも、
// エージェント側でスクリプトを unload し、その直前に rpc.exports.dispose を呼ぶ
// (2026-09-14 に frida 16.7.19 で host を taskkill /F して実測)。
// ここで閉じないと、hook が消えた後も Discord 内部の常時送信フラグが残り、
// 再アタッチした新しい hook が次の GetStats で閉じるまで生マイクが流れ続ける。
// Connection* の扱いは gateClose と同じ(退出を検知したら gateConn は捨てられている)。
rpc.exports = {
  dispose(){
    gateForced = false;
    if (gateApplied) applyGate(false);
  }
};

(function installGateHook(){
  const vm = Process.findModuleByName(VOICE_MOD);
  if (!vm){ send({ev:"error", msg:VOICE_MOD+" not loaded (gate)"}); return; }
  let getStats = null, setPttAddr = null;
  try {
    for (const e of vm.enumerateExports()){
      if (!getStats  && e.name.indexOf("?GetStats@Connection@voice@discord@@") === 0) getStats = e.address;
      if (!setPttAddr && e.name.indexOf("?SetPTTActive@Connection@voice@discord@@") === 0) setPttAddr = e.address;
    }
  } catch(e){}
  if (!getStats){ send({ev:"error", msg:"GetStats export not found (gate)"}); return; }
  if (setPttAddr){ setPTT = new NativeFunction(setPttAddr, "void", ["pointer", "int", "int", "int"]); }
  else { send({ev:"error", msg:"SetPTTActive export not found (gate)"}); }
  Interceptor.attach(getStats, {
    onEnter(args){
      const cur = args[0];
      // 退出を誤検知して gateConn を捨てた後、同じ Connection* で GetStats が再開した場合。
      // VC は生きていて接続も張り替わっていないので、「新しい接続」として扱ってはいけない。
      // 扱うと gateApplied を false に戻したうえで gateForced のまま applyGate(true) を撃つため、
      // Discord 側の状態は何も変わっていないのに gate:open を出し直し、UI が
      // 送信中 → 閉 → 送信中 と点滅する(残骸クローズの分岐も巻き添えで飛ぶ)。
      // 接続が同じなら「どこまで適用済みか」の記録もそのまま有効なので、ポインタだけ拾い直して
      // 下の定常ルール(gateForced なら冪等に再アサート / 残っていれば閉じる)へ委ねる。
      // gateForced をここで落とさないのは従来どおり: Node 側の open は一過性の vc=false では
      // 下りず gateOpen を送り直してくれないので、勝手に閉じると再生中の音が送信されなくなる。
      // ただしアドレスの一致だけを根拠にしない。gateConn を捨てるのは誤検知のときだけでなく
      // 本当の VC 退出でも起きるので、退出後に Discord が解放済み領域を再利用して同じアドレスへ
      // 新しい Connection を確保すると、本物の張り替えを「誤検知からの復帰」と取り違える。
      // すると gateInfo が飛ばず、gateApplied も退出前の値を引き継ぐ。gateUnsafe で
      // micTransmit が 'unknown' に落ちた後は gateInfo が唯一の復帰経路になることがあるため、
      // その道が塞がる。誤検知は 1 秒以内に GetStats が再開するものなので、時間で線を引く。
      if (!gateConn && gateLastConn && cur.equals(gateLastConn) &&
          gateDroppedAt !== 0 && (Date.now() - gateDroppedAt) <= GATE_READOPT_MS){
        gateConn = cur;
        gateDroppedAt = 0;
      }
      if (!gateConn || !cur.equals(gateConn)){
        // 初回、または VC 再接続で Connection* が変わったとき。旧ポインタは解放済みの
        // 可能性があり、そこへ SetPTTActive を呼ぶとゲートが効かない/native 例外になる。
        // 常に最新へ更新し、gateForced 中なら新接続へ再適用する。
        gateConn = cur;
        gateLastConn = cur;
        gateApplied = false;               // 新接続では未適用として評価し直す
        send({ev:"gateInfo", conn: gateConn.toString(), ready: !!setPTT});
        if (gateForced) applyGate(true);
        // 前セッションの残骸を落とす。VoiceCord が異常終了(タスクマネージャ/クラッシュ/
        // Ctrl+C)すると hook.js ごと消えるが、Discord 内部の常時送信フラグ(ctrl deadline)
        // だけは残り、ユーザーのマイクが VAD を無視して流れ続ける。新しい hook は
        // gateApplied=false から始まるため下の自動クローズには入れず、自力では閉じられない。
        // ここで無条件に SetPTTActive(0) を撃つことで「VoiceCord の再起動」が回復手段になる。
        else applyGate(false);
      } else if (gateForced){
        applyGate(true);                   // 1Hz で再アサート(冪等)
      } else if (gateApplied){
        // 常時送信が Discord 側に残ったままになっている。連打で hb が停滞して VC退出を
        // 誤確定し、gateReset で SetPTTActive(0) を呼べなかった場合にここへ来る。
        // 同じ Connection* で GetStats が発火している = ポインタは生きているので、
        // ここで確実に閉じて喋りっぱなしから自動回復する。
        applyGate(false);
      }
    }
  });
})();

// ---- フック設置 ----
// ビルドで発火する Krisp 関数が異なる:
//   Canary: KrispNCProcessFloat (float, サンプル [-1,1])
//   Stable: KrispNCProcess       (int16, サンプル [-32768,32767])
// 両方をフックし、発火した方に注入する。引数レイアウトは共通(out=args[3], cnt=args[2]=480)。

// フレーム分のミックス結果を貯める作業バッファ。毎フレーム確保すると GC を誘発するので
// FRAME_MAX 分を一度だけ確保して使い回す(形式非依存。i16 でも [-1,1] の float で扱う)。
// 倍精度なのは意図的: 合算途中で単精度に丸めると、clamp 前の加算結果がボイス数に応じて
// 変わってしまう(旧実装は倍精度のアキュムレータに積んでいた)。
const mixBuf = new Float64Array(FRAME_MAX);

// ============================================================================
// 出力レベル計測(キャリブレーション)。
// 合成の直前、この onLeave の中は「相手に送られる最終ドメイン」そのもので、しかも
// buf[] = 自分の声(post-Krisp) と mixBuf[]*master*TX_GAIN = 注入分 に分離している。
// ここで両者の RMS/peak を測ることで、ローカル試聴(Web Audio)では原理的に得られない
// 「相手側での声 vs 注入音の実バランス」が実測できる。clamp 発動(クリップ)も同様。
//
// ~100Hz のホットパスなので常時は回さない。calibStart で始め、frames 枚で自動的に
// 止まる。予算をフック側にも持たせているのは、Node(VoiceCord)が落ちても計測だけが
// 走り続けることが無いようにするため。
// ============================================================================
const CALIB_REPORT = 10;        // 途中経過の送信間隔(フレーム)。~10Hz でメーターに十分
const CALIB_FLOOR  = 0.00316;   // -50dBFS。これ未満のフレームは無音として集計から除く
// 完了時に Node へ渡すブロック数の上限(60 秒相当)。ここを無制限にすると、予算を大きく
// 取った計測で 1 回の send が数百 KB の JSON になる。UI の計測は 3 秒なので実際には届かない。
const CALIB_BLOCK_MAX = 6000;
let calib = null;

function calibStart(tag, frames){
  const budget = num(frames, 500, 60000) | 0;
  const n = budget > 0 ? budget : 500;
  calib = {
    tag: String(tag == null ? '' : tag),
    budget: n,
    left: n,
    frames: 0, tick: 0, total: 0,
    vN: 0, vSum: 0, vPeak: 0,   // 声。発話フレームのみ集計(息継ぎで RMS が薄まらない)
    iN: 0, iSum: 0, iPeak: 0,   // 注入分。鳴っているフレームのみ集計
    clip: 0,
    // 声のフレーム毎の平均二乗。最終的な RMS は Node 側(shared/loudness.ts)が
    // 2 段ゲート(絶対 -50dBFS → 相対 -10dB)を掛けて出す。ここで確定させないのは、
    // 音源のオフライン解析と数え方を 1 箇所に集めるため。フックに同じ式を写すと
    // 片方だけ直したときに声と音源の土俵が静かにズレる。
    // 毎フレーム確保しないよう予算ぶんを一度に取る(ホットパスの GC を誘発しない)。
    vBlocks: new Float64Array(n > CALIB_BLOCK_MAX ? CALIB_BLOCK_MAX : n),
    vBlockN: 0
  };
}

function calibSend(ev, vNow, iNow){
  const msg = {
    ev: ev, tag: calib.tag, frames: calib.frames, budget: calib.budget, total: calib.total,
    clip: calib.clip, master: master, txGain: TX_GAIN,
    // ここの vRms は絶対ゲートだけの暫定値。メーターと進行表示にしか使わない
    // (確定値は calibDone の vBlocks から Node 側が出す)。
    vRms: calib.vN ? Math.sqrt(calib.vSum / calib.vN) : 0, vPeak: calib.vPeak, vN: calib.vN,
    iRms: calib.iN ? Math.sqrt(calib.iSum / calib.iN) : 0, iPeak: calib.iPeak, iN: calib.iN,
    vNow: vNow, iNow: iNow
  };
  // 完了時だけブロック列を積む。~10Hz の途中経過に載せると送信量が予算の二乗で増える。
  if (ev === "calibDone"){
    const out = new Array(calib.vBlockN);
    for (let i = 0; i < calib.vBlockN; i++) out[i] = calib.vBlocks[i];
    msg.vBlocks = out;
  }
  send(msg);
}

function calibStop(){
  if (!calib) return;
  calibSend("calibDone", 0, 0);
  calib = null;
}

// buf は合成前(= 声のみ)。scale は i16 なら 1/32768。hasMix=false なら声だけ測る。
function calibFrame(buf, cnt, scale, hasMix, rep){
  const g = master * TX_GAIN;
  let vs = 0, vp = 0, is = 0, ip = 0, clip = 0;
  for (let i = 0; i < cnt; i++){
    const v = buf[i] * scale;
    const av = v < 0 ? -v : v;
    vs += v * v; if (av > vp) vp = av;
    if (hasMix){
      const inj = mixBuf[i] * g;
      const ai = inj < 0 ? -inj : inj;
      is += inj * inj; if (ai > ip) ip = ai;
      const s = (rep ? 0.0 : v) + inj;
      if (s > 1.0 || s < -1.0) clip++;      // 実際に clamp が効いた回数
    }
  }
  // フレームの平均二乗をそのまま記録する(ゲートは掛けない)。無音フレームも含めて
  // 渡さないと、Node 側の相対ゲートが「何が無音だったか」を判断できなくなる。
  if (calib.vBlockN < calib.vBlocks.length) calib.vBlocks[calib.vBlockN++] = vs / cnt;
  const vRms = Math.sqrt(vs / cnt);
  if (vRms > CALIB_FLOOR){
    calib.vSum += vs; calib.vN += cnt;
    if (vp > calib.vPeak) calib.vPeak = vp;
  }
  let iRms = 0;
  if (hasMix){
    iRms = Math.sqrt(is / cnt);
    if (iRms > CALIB_FLOOR){
      calib.iSum += is; calib.iN += cnt;
      if (ip > calib.iPeak) calib.iPeak = ip;
    }
    calib.clip += clip;
  }
  calib.total += cnt; calib.frames++;
  if (++calib.tick >= CALIB_REPORT){ calib.tick = 0; calibSend("calib", vRms, iRms); }
  if (--calib.left <= 0) calibStop();
}

// cnt サンプル分、全voiceを進めて mixBuf へ積む。戻り値は replace モードのvoiceが在るか。
// ループは「サンプル外側 × voice内側」ではなく「voice外側 × サンプル内側」にしてある。
// voice毎の分岐(source有無/loop/mode/音量)を内ループから追い出し、pos・fadeGain を
// ローカル変数で回せるため、voice数に比例する分岐とプロパティ参照が消える。
function mixVoices(cnt){
  let rep = false;
  mixBuf.fill(0.0, 0, cnt);
  for (const v of voices){
    if (v.mode === "replace") rep = true;
    const s = sources[v.srcId];
    let fade = v.fadeGain;
    if (!s){
      // source が unload された -> 無音のままフェードアウトさせて除去へ。
      // 寄与は常に 0 なので、cnt サンプル分の減衰をまとめて適用すれば足りる。
      v.stopping = true;
      fade -= FADE * cnt;
      v.fadeGain = fade < 0 ? 0 : fade;
      continue;
    }
    const data = s.data, total = s.total, vol = v.vol, loop = v.loop;
    let pos = v.pos, stopping = v.stopping;
    for (let i = 0; i < cnt; i++){
      if (pos >= total){
        if (loop) pos = 0;
        else stopping = true;               // 終端 -> フェードアウトして除去
      }
      const smp = pos < total ? data[pos] : 0.0;
      pos++;
      if (stopping){ fade -= FADE; if (fade < 0) fade = 0; }
      else if (fade < 1){ fade += FADE; if (fade > 1) fade = 1; }
      mixBuf[i] += smp * vol * fade;
    }
    v.pos = pos; v.fadeGain = fade; v.stopping = stopping;
  }
  return rep;
}

function postMix(){
  // フェード完了voiceを掃除 + 再生中フラグ通知(フレーム末で1回)
  if (voices.some(v => v.stopping && v.fadeGain <= 0)){
    const ended = voices.filter(v => v.stopping && v.fadeGain <= 0);
    voices = voices.filter(v => !(v.stopping && v.fadeGain <= 0));
    for (const v of ended) send({ev:"voiceEnded", voiceId: v.voiceId, remaining: voices.length});
  }
  const now = voices.length > 0;
  if (now !== playing){ playing = now; send({ev:"activity", playing: now}); }
}

function krispEnter(args){
  // KrispNCProcess[Float](session, in, cnt, out, outCap)
  this.out = args[3];
  this.cnt = args[2].toInt32();
  if (this.cnt > 0 && this.cnt <= FRAME_MAX) hb++;   // VC在席ハートビート(両ビルド共通)
}

// 最初に発火した Krisp 形式にロックし、もう一方の注入は無視(二重注入/倍速防止)。
let krispMode = null;   // "float" | "i16"

// 出力バッファはサンプル毎ではなく一括で読み書きする。out.add(i*4).readFloat() 等は
// 1サンプルにつき NativePointer 生成と JS↔native の往復を伴うため、480サンプル×~100Hz で
// JS スレッドを飽和させ、Krisp スレッドを詰まらせる(hb 停滞 → VC退出の誤検知に繋がる)。
// 読み書きをフレーム毎の 2 回に畳み、間の演算は TypedArray 上で完結させる。
function mixFloat(){
  if (krispMode === null) krispMode = "float";
  else if (krispMode !== "float") return;
  const out = this.out, cnt = this.cnt;
  if (cnt <= 0 || cnt > FRAME_MAX) return;
  if (voices.length === 0){
    // 注入が無い間は読むだけで書き戻さない。声だけのレベルはここでしか測れない。
    if (calib){
      const vb = out.readByteArray(cnt * 4);
      if (vb) calibFrame(new Float32Array(vb), cnt, 1.0, false, false);
    }
    return;
  }
  const ab = out.readByteArray(cnt * 4);
  if (!ab) return;
  const buf = new Float32Array(ab);
  const rep = mixVoices(cnt);
  // 合成の直前で測る。分岐はフレーム毎に1回だけで、下のサンプル内ループには触れない
  // (非計測時の追加コストは null チェック 1 回)。
  if (calib) calibFrame(buf, cnt, 1.0, true, rep);
  for (let i = 0; i < cnt; i++){
    let outv = (rep ? 0.0 : buf[i]) + mixBuf[i] * master * TX_GAIN;
    if (outv >  1.0) outv =  1.0;
    else if (outv < -1.0) outv = -1.0;
    buf[i] = outv;
  }
  out.writeByteArray(ab);
  postMix();
}

function mixI16(){
  if (krispMode === null) krispMode = "i16";
  else if (krispMode !== "i16") return;
  const out = this.out, cnt = this.cnt;
  if (cnt <= 0 || cnt > FRAME_MAX) return;
  if (voices.length === 0){
    if (calib){
      const vb = out.readByteArray(cnt * 2);
      if (vb) calibFrame(new Int16Array(vb), cnt, 1 / 32768, false, false);
    }
    return;
  }
  const ab = out.readByteArray(cnt * 2);
  if (!ab) return;
  const buf = new Int16Array(ab);
  const rep = mixVoices(cnt);
  if (calib) calibFrame(buf, cnt, 1 / 32768, true, rep);
  for (let i = 0; i < cnt; i++){
    let outv = (rep ? 0.0 : buf[i] / 32768.0) + mixBuf[i] * master * TX_GAIN;   // [-1,1)
    if (outv >  1.0) outv =  1.0;
    else if (outv < -1.0) outv = -1.0;
    buf[i] = (outv * 32767) | 0;
  }
  out.writeByteArray(ab);
  postMix();
}

function tryExport(m, name){ try { return m.getExportByName(name); } catch(e){ return null; } }

const mod = Process.findModuleByName(MOD);
if (!mod){ send({ev:"error", msg:MOD+" not loaded"}); }
else {
  const fFloat = tryExport(mod, "KrispNCProcessFloat");
  const fI16   = tryExport(mod, "KrispNCProcess");
  if (fFloat) Interceptor.attach(fFloat, { onEnter: krispEnter, onLeave: mixFloat });
  if (fI16)   Interceptor.attach(fI16,   { onEnter: krispEnter, onLeave: mixI16 });
  if (!fFloat && !fI16){
    send({ev:"error", msg:"Krisp NC export (Float/int16) not found"});
  } else {
    // VC在席の監視: 発火する Krisp 関数(~100Hz)の hb 増減で VC 接続/切断を通知。
    let hbLast = 0;
    // hb が止まる原因は「VC退出」だけではない。自分をミュートする / 入力デバイスを
    // 切り替える / frida VM が一瞬飽和する、でも止まる。vc イベント自体は 1 ティックで
    // 出してよい(Node も renderer も 2.5 秒デバウンスしてから確定させる)が、
    // **再生中ボイスの破棄だけは取り返しがつかない**ので、停滞が続いたときだけ行う。
    // 以前はここに猶予が無く、再生中にミュートしただけで音がぶつ切りになり、行も消えた。
    // 400ms × 7 = 2.8 秒。Node 側の vcRevertDelayMs(2500ms)より長くする。
    const DROP_AFTER_TICKS = 7;
    let idleTicks = 0;
    setInterval(function(){
      const active = (hb !== hbLast);
      hbLast = hb;
      idleTicks = active ? 0 : (idleTicks + 1);
      // 停滞が続いた時点で、遅れて後始末する(vc の通知は下で既に済んでいる)。
      if (!active && idleTicks === DROP_AFTER_TICKS && voices.length){
        const ended = voices;
        voices = [];
        for (const v of ended) send({ev:"voiceEnded", voiceId: v.voiceId, remaining: 0});
        if (playing){ playing = false; send({ev:"activity", playing: false}); }
      }
      if (active === vcActive) return;
      vcActive = active;
      // VC を抜けると onLeave が止まり、ボイスの寿命管理(postMix)も一緒に止まる。
      // voices が凍結したまま残るため、再入場すると pos を保持したまま続きから鳴り出し、
      // mode="replace" なら残りが終わるまで自分の声が消える(ループなら恒久的に置換)。
      // VOICE_MAX にも張り付く。ここで即破棄する(どうせ送信されないのでフェード不要)。
      if (!active){
        // VC を抜けた時点で Connection* を捨てる。これ以降 applyGate は先頭で return するので、
        // Node 側から gateClose/gateOpen がどの順序・どのタイミングで来ても、解放済みかも
        // しれないポインタへ SetPTTActive を撃つことがなくなる。
        //
        // Node 側のイベント順序に頼った保護は成立しない: hook は activity を先、vc を後に
        // 送るため、FridaGate.onActivity(false) の時点では vcTimer がまだ張られておらず、
        // 「VC退出の確定待ち中は閉じない」というガードを素通りして doClose が予約される。
        // 保護はここ(ポインタを持つ側)に置くのが正しい。
        //
        // gateForced はここでは落とさない。gateClose が届けば applyGate が no-op でも
        // フラグ自体は下りるし、VC が実は生きていた(hb の一過性停滞)場合は次の GetStats が
        // 1秒以内に同じ Connection* を拾い直して(gateLastConn との一致で判定)、
        // gateForced に応じた再アサート/残骸のクローズで回復する。
        // gateApplied も既存の理由(誤確定からの自動回復)により落とさない。
        //
        // voices の破棄はここでは行わない。この分岐は hb が 1 ティック止まっただけでも
        // 通るため、ミュートや一過性の停滞で再生中の音を捨ててしまう。破棄は上の
        // DROP_AFTER_TICKS 経過後にまとめて行う(そちらは activity も必ず出す)。
        gateConn = null;
        gateDroppedAt = Date.now();   // 直後に同じポインタが来たら誤検知として拾い直す
      }
      send({ev:"vc", active: active});
    }, 400);

    send({ev:"ready"});
  }
}
