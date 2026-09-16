import { cn } from '@/lib/utils'

/**
 * 設定画面の 1 行。Discord 純正の設定と同じく、左に名前と説明、右に操作を置く。
 *
 * スライダーのように横幅が要る操作は右に収まらないので、children として行の下段に置く。
 * 行の区切り線は親の中で最後の行には引かない(セクションの見出しとの間に線が残るのを避ける)。
 */
export function SettingsRow({
  label,
  description,
  control,
  children,
  className
}: {
  label: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('border-b border-border/60 py-3 last:border-b-0', className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm">{label}</div>
          {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  )
}
