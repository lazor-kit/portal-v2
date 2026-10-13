import { useEffect, useMemo, useSyncExternalStore } from "react"
import type { ApprovalRequest } from "@/approval/envelope"
import { portalTransport, type Transport } from "@/chain/transport"
import { programs } from "@/config"
import { TypedReview } from "@/typed/review"

export type { TypedState } from "@/typed/review"

/**
 * A typed request's chain state while it is shown (see `TypedReview`): read
 * once, then a snapshot a second for the Approve click. The page passes a
 * new but identical request on every render that re-evaluates it; that reads
 * nothing again.
 */
export function useTyped(
  request: ApprovalRequest | null,
  active: boolean,
  /** Approve can't be tapped now (the passkey prompt is open, or the answer went): the snapshots' verdict waits. */
  signing = false,
  transportFor: (cluster: ApprovalRequest["cluster"]) => Transport = portalTransport,
) {
  const review = useMemo(() => new TypedReview({ transportFor, configFor: (cluster) => programs[cluster] }), [transportFor])
  review.setSigning(signing)
  const view = useSyncExternalStore(review.subscribe, review.getView)

  useEffect(() => {
    review.show(active ? request : null)
  }, [review, request, active])
  useEffect(() => () => review.dispose(), [review])

  return { state: view.state, canSign: view.canSign, bind: review.bind, retry: review.retry }
}
