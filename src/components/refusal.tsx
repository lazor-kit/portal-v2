import { ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { refusalText } from "@/security/refusal-text"

interface RefusalProps {
  reason: string
  onClose: () => void
}

export function Refusal({ reason, onClose }: RefusalProps) {
  const { title, detail } = refusalText(reason)
  return (
    <div className="flex flex-col items-center text-center gap-3 py-6 px-2" data-testid="refusal" data-reason={reason}>
      <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center text-red-500">
        <ShieldAlert className="w-5 h-5" />
      </div>
      <h1 className="text-base font-bold text-foreground">{title}</h1>
      <p className="text-xs text-muted-foreground leading-relaxed max-w-xs">{detail}</p>
      <Button variant="outline" onClick={onClose} className="mt-2 w-full max-w-xs h-10" data-testid="close">
        Close
      </Button>
    </div>
  )
}
