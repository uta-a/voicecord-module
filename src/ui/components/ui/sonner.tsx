import { Toaster as Sonner } from 'sonner'
import { useDiscordTheme } from '@/lib/theme'

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps): React.JSX.Element => {
  // Discord のテーマに合わせる（固定の dark にすると、ライトテーマで浮く）
  const theme = useDiscordTheme()
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-center"
      duration={1200}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground'
        }
      }}
      {...props}
    />
  )
}

export { Toaster }
