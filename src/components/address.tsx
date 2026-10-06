import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ChevronRight, Copy } from "lucide-react"
import { addressBytes, addressGroups, identicon, IDENTICON_SIZE, shortAddress, spokenFullAddress, spokenShortAddress } from "@/security/address"
import { copyText } from "@/utils/clipboard"

/** A pattern to recognise an address by; never a reason to say two addresses match. */
export function Identicon({ address, size = 20 }: { address: string; size?: number }) {
  const icon = useMemo(() => {
    const bytes = addressBytes(address)
    return bytes ? identicon(bytes) : null
  }, [address])
  if (!icon) return <span className="inline-block shrink-0 rounded-[4px] border border-line" style={{ width: size, height: size }} aria-hidden="true" />
  const cell = 1
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-0.5 -0.5 ${IDENTICON_SIZE + 1} ${IDENTICON_SIZE + 1}`}
      className="shrink-0 rounded-[4px] border border-line bg-surface"
      aria-hidden="true"
      data-testid="identicon"
    >
      {icon.cells.map((on, i) =>
        on ? <rect key={i} x={i % IDENTICON_SIZE} y={Math.floor(i / IDENTICON_SIZE)} width={cell} height={cell} fill={`var(--id-${icon.color})`} /> : null,
      )}
    </svg>
  )
}

/** `7xKX…gAsU` in the mono face, left to right whatever the page direction, read out letter by letter. */
export function ShortAddress({ address }: { address: string }) {
  return (
    <>
      <bdi dir="ltr" className="whitespace-nowrap font-mono" aria-hidden="true">
        {shortAddress(address)}
      </bdi>
      <span className="sr-only">{spokenShortAddress(address)}</span>
    </>
  )
}

/**
 * The address chip: identicon and short form, as one 44px button that opens
 * the whole address. `prefix` is the word before it ("to").
 */
export function AddressChip({ address, prefix, testId = "address-chip" }: { address: string; prefix?: string; testId?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[16px] leading-[24px] text-ink"
        data-testid={testId}
        data-address={address}
      >
        {prefix && <span className="text-ink-2">{prefix}</span>}
        <Identicon address={address} />
        <ShortAddress address={address} />
        <span className="sr-only">. Show full address</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-2" aria-hidden="true" />
      </button>
      {open && <AddressSheet address={address} onClose={() => setOpen(false)} />}
    </>
  )
}

/** A short address in Details: tap to see all of it. */
export function AddressInline({ address }: { address: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center gap-2 text-left underline-offset-4 hover:underline" data-address={address}>
        <Identicon address={address} size={16} />
        <ShortAddress address={address} />
        <span className="sr-only">. Show full address</span>
      </button>
      {open && <AddressSheet address={address} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * The whole address: groups of four, every group alike (setting the first
 * and last apart trains the eye on exactly what a look-alike copies), with
 * Copy. There is no "paste to compare": a poisoned address is one the user
 * already copied.
 */
export function AddressSheet({ address, onClose }: { address: string; onClose: () => void }) {
  const titleId = useId()
  const [copied, setCopied] = useState<"yes" | "no" | null>(null)
  const done = useRef<HTMLButtonElement>(null)
  const back = useRef<Element | null>(null)

  useEffect(() => {
    back.current = document.activeElement
    done.current?.focus()
    return () => (back.current as HTMLElement | null)?.focus?.()
  }, [])

  const copy = async () => setCopied((await copyText(address)) ? "yes" : "no")

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-3 min-[480px]:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm space-y-3 rounded-2xl bg-surface p-5 text-ink shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            onClose()
          } else if (e.key === "Tab") {
            // Keep focus inside the sheet: its two buttons.
            const buttons = [...e.currentTarget.querySelectorAll("button")]
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
            e.preventDefault()
            buttons[(at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus()
          }
        }}
        data-testid="address-sheet"
      >
        <div className="flex items-center gap-3">
          <Identicon address={address} size={40} />
          <h2 id={titleId} className="text-[17px] leading-[24px] font-bold">
            Full address
          </h2>
        </div>
        <p className="font-mono text-[17px] leading-[26px] tracking-wide" dir="ltr" data-testid="full-address">
          <span aria-hidden="true">
            {addressGroups(address).map((group, i) => (
              <span key={i} className="mr-[0.6em] inline-block">
                {group}
              </span>
            ))}
          </span>
          <span className="sr-only">{spokenFullAddress(address)}</span>
        </p>
        <p className="text-[14px] leading-[20px] text-ink-2">Check the whole address, not just the start and end.</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={copy} className="flex h-12 items-center justify-center gap-2 rounded-xl border border-line px-3 text-[16px] font-semibold" data-testid="copy-address">
            <Copy className="h-4 w-4" aria-hidden="true" />
            Copy address
          </button>
          <button ref={done} type="button" onClick={onClose} className="h-12 rounded-xl bg-accent px-3 text-[16px] font-bold text-on-accent" data-testid="address-done">
            Done
          </button>
        </div>
        <p role="status" className="min-h-5 text-center text-[14px] leading-[20px] text-ink-2" data-testid="copy-status">
          {copied === "yes" ? "Address copied" : copied === "no" ? "Couldn't copy. Select the address above to copy it." : ""}
        </p>
      </div>
    </div>
  )
}
