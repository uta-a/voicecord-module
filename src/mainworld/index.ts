import { installHarvester, type HarvestWindow } from './harvest.js'

/**
 * 採取役の入口。preload が webFrame.executeJavaScript でメインワールドに流し込む
 * （payload/harvest.js）。<script> を経由しないので CSP の script-src に当たらない。
 *
 * ここで throw すると Discord のコンソールに出るだけで済むが、念のため包む。
 */
try {
  installHarvester(
    window as unknown as HarvestWindow,
    document,
    (type, detail) => new CustomEvent(type, { detail })
  )
} catch (e) {
  console.error('[VoiceCord] 採取役の初期化に失敗しました', e)
}
